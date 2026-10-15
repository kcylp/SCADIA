module.exports = function(RED) {
    function ScadiaGetDaqNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var tagId = scadia.getTagId(config.tag, null);
                if (tagId) {
                    var fromts = config.from || msg.from || Date.now() - 3600000; // default 1 hour ago
                    var tots = config.to || msg.to || Date.now();
                    var data = await scadia.getDaq(tagId, fromts, tots);
                    msg.payload = data;
                    node.send(msg);
                } else {
                    node.error('Tag not found: ' + config.tag, msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("get-daq", ScadiaGetDaqNode);
}