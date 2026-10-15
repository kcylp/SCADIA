module.exports = function(RED) {
    function ScadiaGetAlarmsNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        // Access SCADIA functions from global context
        var scadia = RED.settings.functionGlobalContext.scadia;

        this.on('input', async function(msg) {
            try {
                var alarms = await scadia.getAlarms();
                msg.payload = alarms;
                node.send(msg);
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("get-alarms", ScadiaGetAlarmsNode);
}