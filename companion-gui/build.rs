fn main() {
    println!("cargo:rerun-if-changed=assets/segma-player.ico");
    let mut resource = winresource::WindowsResource::new();
    resource.set_icon("assets/segma-player.ico");
    resource.compile().expect("embed Segma Player icon");
}
