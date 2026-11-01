use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

// The bun sidecar holds all agent logic; Rust only starts and stops it,
// and owns the native bits the webview can't do (vibrancy, menus, tray).
struct Sidecar(Mutex<Option<CommandChild>>);
// The Model menu is rebuilt from the UI whenever the model list or selection changes.
struct ModelMenu(Submenu<Wry>);

#[derive(serde::Deserialize)]
struct ModelItem {
    id: String,
    label: String,
}

// Where the native traffic lights sit: inside the floating sidebar's header row.
const TRAFFIC_LIGHTS: LogicalPosition<f64> = LogicalPosition { x: 27.0, y: 39.0 };

fn glass(window: &WebviewWindow) {
    if let Err(e) = apply_vibrancy(window, NSVisualEffectMaterial::Sidebar, Some(NSVisualEffectState::FollowsWindowActiveState), None) {
        eprintln!("vibrancy: {e}");
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    // The UI picks the Settings screen from the window label.
    let built = WebviewWindowBuilder::new(app, "settings", WebviewUrl::default())
        .title("Settings")
        .inner_size(760.0, 640.0)
        .min_inner_size(640.0, 480.0)
        .transparent(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(TRAFFIC_LIGHTS)
        .build();
    match built {
        Ok(w) => glass(&w),
        Err(e) => eprintln!("settings window: {e}"),
    }
}

#[tauri::command]
fn set_model_menu(app: AppHandle, models: Vec<ModelItem>, active: Option<String>, loaded: bool) -> Result<(), String> {
    let menu = &app.state::<ModelMenu>().0;
    let err = |e: tauri::Error| e.to_string();
    for item in menu.items().map_err(err)? {
        menu.remove(&item).map_err(err)?;
    }
    for m in &models {
        let item = CheckMenuItemBuilder::with_id(format!("model:{}", m.id), &m.label)
            .checked(active.as_deref() == Some(m.id.as_str()))
            .build(&app)
            .map_err(err)?;
        menu.append(&item).map_err(err)?;
    }
    menu.append(&PredefinedMenuItem::separator(&app).map_err(err)?).map_err(err)?;
    let unload = MenuItemBuilder::with_id("unload", "Unload Model").enabled(loaded).build(&app).map_err(err)?;
    menu.append(&unload).map_err(err)?;
    Ok(())
}

// System accent color (System Settings › Appearance) as #RRGGBB.
#[tauri::command]
fn accent_color() -> Option<String> {
    #[cfg(target_os = "macos")]
    #[allow(unused_unsafe)]
    unsafe {
        use objc2_app_kit::{NSColor, NSColorSpace};
        let c = NSColor::controlAccentColor().colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let hex = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        return Some(format!("#{:02X}{:02X}{:02X}", hex(c.redComponent()), hex(c.greenComponent()), hex(c.blueComponent())));
    }
    #[allow(unreachable_code)]
    None
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    open_settings(&app);
}

// Show a file in Finder (source sheet).
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    std::process::Command::new("open").arg("-R").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn build_menus(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id("settings", "Settings…").accelerator("Cmd+,").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Harness")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let new_chat = MenuItemBuilder::with_id("new_chat", "New Chat").accelerator("Cmd+N").build(app)?;
    let file = SubmenuBuilder::new(app, "File").item(&new_chat).separator().close_window().build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let toggle = MenuItemBuilder::with_id("toggle_sidebar", "Toggle Sidebar").accelerator("Ctrl+Cmd+S").build(app)?;
    let view = SubmenuBuilder::new(app, "View").item(&toggle).separator().fullscreen().build()?;
    let model = SubmenuBuilder::new(app, "Model")
        .item(&MenuItemBuilder::with_id("unload", "Unload Model").enabled(false).build(app)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().close_window().build()?;
    let help = SubmenuBuilder::new(app, "Help").build()?;
    let menu = MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &model, &window, &help]).build()?;
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    {
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }
    app.manage(ModelMenu(model));

    let tray_menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("quick_ask", "Quick Ask").build(app)?)
        .item(&MenuItemBuilder::with_id("unload", "Unload Model").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit Harness").build(app)?)
        .build()?;
    TrayIconBuilder::with_id("tray")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Harness")
        .menu(&tray_menu)
        .show_menu_on_left_click(true)
        .build(app)?;

    app.on_menu_event(|app, event| match event.id().as_ref() {
        "settings" => open_settings(app),
        "quit" => app.exit(0),
        // TODO(quick-ask milestone): open the ⌥Space floating panel (tauri-nspanel) instead.
        "quick_ask" => {
            show_main(app);
            let _ = app.emit_to("main", "menu", "new_chat");
        }
        // Chat-level actions (new chat, sidebar, model pick, unload) are handled by the main UI.
        id => {
            let _ = app.emit_to("main", "menu", id);
        }
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![set_model_menu, accent_color, open_settings_window, reveal])
        .setup(|app| {
            build_menus(app.handle())?;
            if let Some(main) = app.get_webview_window("main") {
                glass(&main);
            }
            // In dev, `bun run dev` runs the server with --watch instead.
            if cfg!(debug_assertions) {
                return Ok(());
            }
            let (mut rx, child) = app
                .shell()
                .sidecar("harness-server")?
                .env("HARNESS_SIDECAR", "1")
                .spawn()?;
            *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            print!("[server] {}", String::from_utf8_lossy(&line))
                        }
                        CommandEvent::Terminated(t) => eprintln!("[server] exited: {:?}", t.code),
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Clicking the Dock icon with no window open brings the chat back.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows: false, .. } => show_main(app),
            RunEvent::Exit => {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    // Ask the server to stop mlx_vlm.server cleanly, then make sure it's gone.
                    let _ = child.write(b"shutdown\n");
                    std::thread::sleep(Duration::from_millis(800));
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}
