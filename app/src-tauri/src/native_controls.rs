// Real AppKit controls (NSSlider, NSSwitch) floated over the webview where the page leaves a
// placeholder. WebKit draws its own form controls, so this is the only way to get the system's
// Liquid Glass slider and switch. The page sends frames (CSS px == points) and listens for
// "native-control" events with the new value.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, ClassType, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSControl, NSControlStateValueOff, NSControlStateValueOn, NSSlider, NSSwitch, NSView};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

static APP: OnceLock<AppHandle> = OnceLock::new();
// NSControl tag → (control id, window label), read by the action handler.
static TAGS: OnceLock<Mutex<HashMap<isize, (String, String)>>> = OnceLock::new();

struct Native {
    clip: Retained<NSView>, // clips the control to the page's scroll area
    control: Retained<NSControl>,
    is_switch: bool,
}

thread_local! {
    static CONTROLS: RefCell<HashMap<String, Native>> = RefCell::new(HashMap::new());
    static TARGET: RefCell<Option<Retained<ControlTarget>>> = const { RefCell::new(None) };
    static NEXT_TAG: RefCell<isize> = const { RefCell::new(1) };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HarnessControlTarget"]
    struct ControlTarget;

    impl ControlTarget {
        #[unsafe(method(changed:))]
        fn changed(&self, sender: &NSControl) {
            let value = if sender.isKindOfClass(NSSwitch::class()) {
                let on: &NSSwitch = unsafe { &*(sender as *const NSControl as *const NSSwitch) };
                if on.state() == NSControlStateValueOn { 1.0 } else { 0.0 }
            } else {
                sender.doubleValue()
            };
            let hit = TAGS.get().and_then(|t| t.lock().unwrap().get(&sender.tag()).cloned());
            if let (Some(app), Some((id, label))) = (APP.get(), hit) {
                let _ = app.emit_to(label.as_str(), "native-control", serde_json::json!({ "id": id, "value": value }));
            }
        }
    }
);

#[derive(Deserialize)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    id: String,
    kind: String, // "slider" | "switch"
    frame: Rect,  // placeholder, in page coordinates
    clip: Rect,   // visible scroll area, in page coordinates
    value: f64,
    #[serde(default)]
    min: f64,
    #[serde(default = "one")]
    max: f64,
    #[serde(default)]
    ticks: isize,
    #[serde(default)]
    label: String,
}
fn one() -> f64 {
    1.0
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
}

// Create or move/update a control. `remove` drops it.
#[tauri::command]
pub fn native_control(window: WebviewWindow, spec: Option<Spec>, remove: Option<String>) {
    let app = window.app_handle().clone();
    let _ = APP.set(app);
    let label = window.label().to_string();
    let _ = window.with_webview(move |wv| {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let webview: &NSView = unsafe { &*(wv.inner() as *const NSView) };
        if let Some(id) = remove {
            CONTROLS.with(|c| {
                if let Some(n) = c.borrow_mut().remove(&id) {
                    n.clip.removeFromSuperview();
                }
            });
            return;
        }
        if let Some(spec) = spec {
            upsert(mtm, webview, &label, spec);
        }
    });
}

fn upsert(mtm: MainThreadMarker, webview: &NSView, label: &str, s: Spec) {
    let target = TARGET.with(|t| {
        t.borrow_mut()
            .get_or_insert_with(|| unsafe { msg_send![ControlTarget::alloc(mtm), init] })
            .clone()
    });
    CONTROLS.with(|c| {
        let mut map = c.borrow_mut();
        let fresh = !map.contains_key(&s.id);
        if fresh {
            let tag = NEXT_TAG.with(|n| {
                let t = *n.borrow();
                *n.borrow_mut() += 1;
                t
            });
            TAGS.get_or_init(Default::default).lock().unwrap().insert(tag, (s.id.clone(), label.to_string()));
            let is_switch = s.kind == "switch";
            let control: Retained<NSControl> = if is_switch {
                let sw = NSSwitch::new(mtm);
                Retained::into_super(sw)
            } else {
                let target_obj: &AnyObject = &target;
                let sl = unsafe { NSSlider::sliderWithValue_minValue_maxValue_target_action(s.value, s.min, s.max, Some(target_obj), Some(sel!(changed:)), mtm) };
                if s.ticks > 1 {
                    sl.setNumberOfTickMarks(s.ticks);
                    sl.setAllowsTickMarkValuesOnly(true);
                }
                Retained::into_super(sl)
            };
            unsafe {
                control.setTarget(Some(&target));
                control.setAction(Some(sel!(changed:)));
            }
            control.setTag(tag);
            if !s.label.is_empty() {
                let l = objc2_foundation::NSString::from_str(&s.label);
                let _: () = unsafe { msg_send![&*control, setAccessibilityLabel: &*l] };
            }
            let _: () = unsafe { msg_send![&*control, sizeToFit] };
            let clip = NSView::new(mtm);
            clip.setClipsToBounds(true);
            clip.addSubview(&control);
            clip.setAlphaValue(0.0);
            webview.addSubview(&clip);
            // Fade in like the rest of the page.
            let animator: Retained<AnyObject> = unsafe { msg_send![&*clip, animator] };
            let _: () = unsafe { msg_send![&*animator, setAlphaValue: 1.0f64] };
            map.insert(s.id.clone(), Native { clip, control, is_switch });
        }
        let n = map.get(&s.id).unwrap();
        // Value (skip while the user is dragging, it already has it).
        if n.is_switch {
            let sw: &NSSwitch = unsafe { &*(&*n.control as *const NSControl as *const NSSwitch) };
            sw.setState(if s.value >= 0.5 { NSControlStateValueOn } else { NSControlStateValueOff });
        } else if (n.control.doubleValue() - s.value).abs() > f64::EPSILON {
            n.control.setDoubleValue(s.value);
        }
        // Geometry: page coords are top-left; flip if the webview isn't.
        let bounds = webview.bounds();
        let flip = |y: f64, h: f64| if webview.isFlipped() { y } else { bounds.size.height - y - h };
        n.clip.setFrame(rect(s.clip.x, flip(s.clip.y, s.clip.h), s.clip.w, s.clip.h));
        let natural = n.control.frame().size;
        let (w, h) = if n.is_switch { (natural.width, natural.height) } else { (s.frame.w, natural.height.max(1.0)) };
        // Centered in the placeholder, relative to the clip view (which is never flipped).
        let x = s.frame.x - s.clip.x + (s.frame.w - w) / 2.0;
        let top = s.frame.y - s.clip.y + (s.frame.h - h) / 2.0;
        n.control.setFrame(rect(x, s.clip.h - top - h, w, h));
    });
}
