module.exports = function(RED) {
    function ScadiaGetDeviceNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var deviceName = config.deviceName || msg.deviceName;
                var includeTags = (config.includeTags !== undefined) ? config.includeTags : (msg.includeTags !== undefined ? msg.includeTags : true);

                if (deviceName) {
                    var device = await scadia.getDevice(deviceName, includeTags);
                    msg.payload = device;
                    node.send(msg);
                } else {
                    node.error('Device name not specified', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("get-device", ScadiaGetDeviceNode);
}