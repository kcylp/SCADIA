module.exports = function(RED) {
    function ScadiaAckAlarmNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var alarmName = config.alarmName || msg.alarmName || msg.payload;
                var types = config.types || msg.types;
                if (typeof types === 'string') {
                    types = types.split(',').map(s => s.trim());
                }
                if (alarmName) {
                    var result = await scadia.ackAlarm(alarmName, types);
                    msg.payload = result;
                    node.send(msg);
                } else {
                    node.error('Missing alarm name', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("ack-alarm", ScadiaAckAlarmNode);
}