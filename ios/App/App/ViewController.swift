import Capacitor
import CapApp_SPM

final class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CodexRemoteNativePlugin())
    }
}
