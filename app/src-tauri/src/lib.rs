use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// The bun sidecar holds all agent logic; Rust only starts and stops it.
struct Sidecar(Mutex<Option<CommandChild>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
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
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    // Ask the server to stop mlx_lm.server cleanly, then make sure it's gone.
                    let _ = child.write(b"shutdown\n");
                    std::thread::sleep(Duration::from_millis(800));
                    let _ = child.kill();
                }
            }
        });
}
