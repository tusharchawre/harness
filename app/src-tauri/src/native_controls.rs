// Real AppKit controls floated over the webview where the page leaves a placeholder.
// WebKit draws its own form controls, so this is the only way to get the system's
// Liquid Glass slider, switch, popup button, search field and segmented controls.
// The page sends frames (CSS px == points) and listens for "native-control" events.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, ClassType, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSControl, NSControlStateValueOff, NSControlStateValueOn, NSImage, NSPopUpButton, NSSearchField, NSSegmentStyle,
    NSSegmentSwitchTracking, NSSegmentedControl, NSSlider, NSSwitch, NSView,
};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

static APP: OnceLock<AppHandle> = OnceLock::new();
// Control address → (control id, window label), read by the action handler.
// (Not NSControl tags: cell-less controls like NSSwitch don't keep one.)
static OWNERS: OnceLock<Mutex<HashMap<usize, (String, String)>>> = OnceLock::new();

struct Native {
    clip: Retained<NSView>, // clips the control to the page's scroll area
    control: Retained<NSControl>,
    kind: String,
    items: Vec<String>,
}

thread_local! {
    static CONTROLS: RefCell<HashMap<String, Native>> = RefCell::new(HashMap::new());
    static TARGET: RefCell<Option<Retained<ControlTarget>>> = const { RefCell::new(None) };
    // Removed controls finish fading out here before leaving the view tree.
    static DYING: RefCell<HashMap<String, Retained<NSView>>> = RefCell::new(HashMap::new());
}

// Downcast helper: the caller knows the concrete class from `kind`.
unsafe fn cast<T>(c: &NSControl) -> &T {
    &*(c as *const NSControl as *const T)
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HarnessControlTarget"]
    struct ControlTarget;

    impl ControlTarget {
        #[unsafe(method(changed:))]
        fn changed(&self, sender: &NSControl) {
            let mut text: Option<String> = None;
            let value = unsafe {
                if sender.isKindOfClass(NSSwitch::class()) {
                    if cast::<NSSwitch>(sender).state() == NSControlStateValueOn { 1.0 } else { 0.0 }
                } else if sender.isKindOfClass(NSPopUpButton::class()) {
                    cast::<NSPopUpButton>(sender).indexOfSelectedItem() as f64
                } else if sender.isKindOfClass(NSSegmentedControl::class()) {
                    cast::<NSSegmentedControl>(sender).selectedSegment() as f64
                } else if sender.isKindOfClass(NSSearchField::class()) {
                    text = Some(sender.stringValue().to_string());
                    0.0
                } else {
                    sender.doubleValue()
                }
            };
            let key = sender as *const NSControl as usize;
            let hit = OWNERS.get().and_then(|t| t.lock().unwrap().get(&key).cloned());
            if let (Some(app), Some((id, label))) = (APP.get(), hit) {
                let _ = app.emit_to(label.as_str(), "native-control", serde_json::json!({ "id": id, "value": value, "text": text }));
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
    kind: String, // slider | switch | popup | search | segmented
    frame: Rect,  // placeholder, in page coordinates
    clip: Rect,   // visible scroll area, in page coordinates
    #[serde(default)]
    value: f64,
    #[serde(default)]
    min: f64,
    #[serde(default = "one")]
    max: f64,
    #[serde(default)]
    ticks: isize,
    #[serde(default)]
    label: String,
    #[serde(default)]
    items: Vec<String>, // popup titles, or segmented SF Symbol names
    #[serde(default)]
    enabled: Vec<bool>, // per segment
    #[serde(default)]
    style: String, // segmented: "separated" | "smallSquare"
    #[serde(default)]
    text: String, // search: initial text
    #[serde(default)]
    placeholder: String,
    #[serde(default)]
    align: String, // "start" | "center" | "end" | "stretch" (natural size unless stretch)
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
    let _ = APP.set(window.app_handle().clone());
    let label = window.label().to_string();
    let _ = window.with_webview(move |wv| {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let webview: &NSView = unsafe { &*(wv.inner() as *const NSView) };
        if let Some(id) = remove {
            let Some(n) = CONTROLS.with(|c| c.borrow_mut().remove(&id)) else { return };
            if let Some(o) = OWNERS.get() {
                o.lock().unwrap().remove(&(&*n.control as *const NSControl as usize));
            }
            // Fade out with the page, then drop the view.
            let animator: Retained<AnyObject> = unsafe { msg_send![&*n.clip, animator] };
            let _: () = unsafe { msg_send![&*animator, setAlphaValue: 0.0f64] };
            let key = format!("{id}:{:p}", &*n.clip);
            DYING.with(|d| d.borrow_mut().insert(key.clone(), n.clip));
            if let Some(app) = APP.get().cloned() {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    let _ = app.run_on_main_thread(move || {
                        if let Some(v) = DYING.with(|d| d.borrow_mut().remove(&key)) {
                            v.removeFromSuperview();
                        }
                    });
                });
            }
            return;
        }
        if let Some(spec) = spec {
            upsert(mtm, webview, &label, spec);
        }
    });
}

fn titles(items: &[String]) -> Retained<NSArray<NSString>> {
    let v: Vec<Retained<NSString>> = items.iter().map(|s| NSString::from_str(s)).collect();
    NSArray::from_retained_slice(&v)
}

fn create(mtm: MainThreadMarker, s: &Spec, target: &Retained<ControlTarget>) -> Retained<NSControl> {
    let target_obj: &AnyObject = target;
    let control: Retained<NSControl> = match s.kind.as_str() {
        "switch" => Retained::into_super(NSSwitch::new(mtm)),
        "popup" => {
            let p = NSPopUpButton::initWithFrame_pullsDown(NSPopUpButton::alloc(mtm), rect(0.0, 0.0, 100.0, 24.0), false);
            p.addItemsWithTitles(&titles(&s.items));
            Retained::into_super(Retained::into_super(p))
        }
        "search" => {
            let f = NSSearchField::new(mtm);
            f.setSendsSearchStringImmediately(true);
            if !s.placeholder.is_empty() {
                f.setPlaceholderString(Some(&NSString::from_str(&s.placeholder)));
            }
            f.setStringValue(&NSString::from_str(&s.text));
            Retained::into_super(Retained::into_super(f))
        }
        "segmented" => {
            let images: Vec<Retained<NSImage>> = s
                .items
                .iter()
                .filter_map(|name| NSImage::imageWithSystemSymbolName_accessibilityDescription(&NSString::from_str(name), None))
                .collect();
            let seg = unsafe {
                NSSegmentedControl::segmentedControlWithImages_trackingMode_target_action(
                    &NSArray::from_retained_slice(&images),
                    NSSegmentSwitchTracking::Momentary,
                    Some(target_obj),
                    Some(sel!(changed:)),
                    mtm,
                )
            };
            seg.setSegmentStyle(if s.style == "smallSquare" { NSSegmentStyle::SmallSquare } else { NSSegmentStyle::Separated });
            Retained::into_super(seg)
        }
        _ => {
            let sl = unsafe { NSSlider::sliderWithValue_minValue_maxValue_target_action(s.value, s.min, s.max, Some(target_obj), Some(sel!(changed:)), mtm) };
            if s.ticks > 1 {
                sl.setNumberOfTickMarks(s.ticks);
                sl.setAllowsTickMarkValuesOnly(true);
            }
            Retained::into_super(sl)
        }
    };
    unsafe {
        control.setTarget(Some(target_obj));
        control.setAction(Some(sel!(changed:)));
    }
    if !s.label.is_empty() {
        let l = NSString::from_str(&s.label);
        let _: () = unsafe { msg_send![&*control, setAccessibilityLabel: &*l] };
    }
    control
}

fn upsert(mtm: MainThreadMarker, webview: &NSView, label: &str, s: Spec) {
    let target = TARGET.with(|t| t.borrow_mut().get_or_insert_with(|| unsafe { msg_send![ControlTarget::alloc(mtm), init] }).clone());
    CONTROLS.with(|c| {
        let mut map = c.borrow_mut();
        if !map.contains_key(&s.id) {
            let control = create(mtm, &s, &target);
            OWNERS
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .insert(&*control as *const NSControl as usize, (s.id.clone(), label.to_string()));
            let clip = NSView::new(mtm);
            clip.setClipsToBounds(true);
            clip.addSubview(&control);
            clip.setAlphaValue(0.0);
            webview.addSubview(&clip);
            // Fade in like the rest of the page.
            let animator: Retained<AnyObject> = unsafe { msg_send![&*clip, animator] };
            let _: () = unsafe { msg_send![&*animator, setAlphaValue: 1.0f64] };
            map.insert(s.id.clone(), Native { clip, control, kind: s.kind.clone(), items: s.items.clone() });
        }
        let n = map.get_mut(&s.id).unwrap();
        let c = &n.control;
        unsafe {
            match n.kind.as_str() {
                "switch" => cast::<NSSwitch>(c).setState(if s.value >= 0.5 { NSControlStateValueOn } else { NSControlStateValueOff }),
                "popup" => {
                    let p = cast::<NSPopUpButton>(c);
                    if n.items != s.items {
                        p.removeAllItems();
                        p.addItemsWithTitles(&titles(&s.items));
                        n.items = s.items.clone();
                    }
                    if p.indexOfSelectedItem() != s.value as isize {
                        p.selectItemAtIndex(s.value as isize);
                    }
                }
                "segmented" => {
                    let seg = cast::<NSSegmentedControl>(c);
                    for (i, on) in s.enabled.iter().enumerate() {
                        seg.setEnabled_forSegment(*on, i as isize);
                    }
                }
                "search" => {}
                _ => {
                    if (c.doubleValue() - s.value).abs() > f64::EPSILON {
                        c.setDoubleValue(s.value);
                    }
                }
            }
        }
        let _: () = unsafe { msg_send![&**c, sizeToFit] };

        // Geometry: page coords are top-left; flip if the webview isn't.
        let bounds = webview.bounds();
        let flipped = webview.isFlipped();
        let flip = |y: f64, h: f64| if flipped { y } else { bounds.size.height - y - h };
        n.clip.setFrame(rect(s.clip.x, flip(s.clip.y, s.clip.h), s.clip.w, s.clip.h));
        let natural = c.frame().size;
        let stretch = s.align == "stretch" || (s.align.is_empty() && matches!(n.kind.as_str(), "slider" | "search"));
        let w = if stretch { s.frame.w } else { natural.width.min(s.frame.w.max(natural.width)) };
        let h = natural.height.max(1.0);
        let dx = match s.align.as_str() {
            "start" => 0.0,
            "end" => s.frame.w - w,
            _ => (s.frame.w - w) / 2.0,
        };
        // Relative to the clip view (which is never flipped).
        let x = s.frame.x - s.clip.x + dx;
        let top = s.frame.y - s.clip.y + (s.frame.h - h) / 2.0;
        c.setFrame(rect(x, s.clip.h - top - h, w, h));
    });
}
