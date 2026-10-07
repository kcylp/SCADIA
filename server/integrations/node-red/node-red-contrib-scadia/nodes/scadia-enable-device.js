module.exports = function(RED) {
    function ScadiaEnableDeviceNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = RED.settings.functionGlobalContext.scadia;

        this.on('input', async function(msg) {
            try {
                var deviceName = config.deviceName || msg.deviceName;
                var enabled = (config.enabled !== undefined) ? config.enabled : (msg.enabled !== undefined ? msg.enabled : true);

                if (deviceName) {
                    var result = await scadia.enableDevice(deviceName, enabled);
                    msg.payload = result;
                    node.send(msg);
                } else {
                    node.error('Device name not specified', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("enable-device", ScadiaEnableDeviceNode);
}