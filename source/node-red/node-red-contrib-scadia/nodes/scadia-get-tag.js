module.exports = function(RED) {
    function ScadiaGetTagNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', function(msg) {
            try {
                var tagId = scadia.getTagId(config.tag, null);
                if (tagId) {
                    var value = scadia.getTag(tagId);
                    msg.payload = value;
                    node.send(msg);
                } else {
                    node.error('Tag not found: ' + config.tag, msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("get-tag", ScadiaGetTagNode);
}