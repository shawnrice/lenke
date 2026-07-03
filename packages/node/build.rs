// napi-build wires up the N-API symbol resolution and emits the platform glue
// the generated loader expects. Required for every napi-rs addon.
fn main() {
    napi_build::setup();
}
