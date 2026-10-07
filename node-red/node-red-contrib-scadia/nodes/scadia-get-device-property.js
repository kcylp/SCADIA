module.exports = function(RED) {
    function ScadiaGetDevicePropertyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var deviceName = config.deviceName || msg.deviceName;
                var property = config.property || msg.property;

                if (deviceName && property) {
                    var result = await scadia.getDeviceProperty(deviceName, property);
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
    RED.nodes.registerType("get-device-property", ScadiaGetDevicePropertyNode);
}