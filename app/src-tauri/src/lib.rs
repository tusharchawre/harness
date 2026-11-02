use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindow, Wry};
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

// Settings is a modal sheet inside the main window.
fn open_settings(app: &AppHandle) {
    show_main(app);
    let _ = app.emit_to("main", "menu", "settings");
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
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

// Open a link from a reply in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err("unsupported link".into());
    }
    std::process::Command::new("open").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![set_model_menu, accent_color, show_main_window, reveal, open_url])
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
                .env("HARNESS_PARENT_PID", std::process::id().to_string())
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
                    // stdin can be closed under Tauri, so also send SIGTERM: the server's handler
                    // stops mlx_vlm.server and clears its PID file. kill() below is SIGKILL (no cleanup).
                    let _ = std::process::Command::new("kill").arg("-TERM").arg(child.pid().to_string()).status();
                    std::thread::sleep(Duration::from_millis(800));
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}
