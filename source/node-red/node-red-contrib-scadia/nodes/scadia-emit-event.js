module.exports = function(RED) {
    function ScadiaEmitEventNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', function(msg) {
            try {
                scadia.emit(config.eventType, msg.payload);
                node.send(msg);
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("emit-event", ScadiaEmitEventNode);
}