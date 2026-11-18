use pi_web::engine::Engine;
use pi_web::operations::WebHandler;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--git-worker" {
        std::process::exit(pi_web::git::run_worker());
    }
    if !args.is_empty() {
        std::process::exit(1);
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => std::process::exit(1),
    };
    let handler = match WebHandler::new() {
        Ok(handler) => handler,
        Err(_) => std::process::exit(1),
    };
    let reason =
        runtime.block_on(Engine::new(handler).run(tokio::io::stdin(), tokio::io::stdout()));
    std::process::exit(reason.exit_code());
}
