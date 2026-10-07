module.exports = function(RED) {
    function ScadiaSendMessageNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var scadia = this.context().global.get('scadia');

        this.on('input', async function(msg) {
            try {
                var address = config.address || msg.address;
                var subject = config.subject || msg.subject;
                var message = config.message || msg.message || msg.payload;
                if (address && subject && message) {
                    await scadia.sendMessage(address, subject, message);
                    node.send(msg);
                } else {
                    node.error('Missing address, subject, or message', msg);
                }
            } catch (err) {
                node.error(err, msg);
            }
        });
    }
    RED.nodes.registerType("send-message", ScadiaSendMessageNode);
}