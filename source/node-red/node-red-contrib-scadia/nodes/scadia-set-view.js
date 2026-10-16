module.exports = function(RED) {
    function ScadiaSetViewNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var viewName = config.viewName || msg.viewName;
                if (viewName) {
                    var result = await scadia.setView(viewName);
                    msg.payload = result;
                    node.send(msg);
                } else {
                    node.error('View name not specified', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("set-view", ScadiaSetViewNode);
}