module.exports = function(RED) {
    function ScadiaSetDevicePropertyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var deviceName = config.deviceName || msg.deviceName;
                var property = config.property || msg.property;
                var value = config.value;
                if (msg.value !== undefined) value = msg.value;

                if (deviceName && property !== undefined) {
                    var result = await scadia.setDeviceProperty(deviceName, property, value);
                    msg.payload = result;
                    node.send(msg);
                } else {
                    node.error('Device name and property not specified', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("set-device-property", ScadiaSetDevicePropertyNode);
}