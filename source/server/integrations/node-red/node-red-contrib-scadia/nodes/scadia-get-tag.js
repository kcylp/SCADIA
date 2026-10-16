module.exports = function(RED) {
    function ScadiaGetTagNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Access SCADIA functions from global context
        const scadia = RED.settings?.functionGlobalContext?.scadia;

        node.on("input", function(msg, send, done) {
            send = send || node.send.bind(node);

            try {
                if (!scadia) {
                    node.error("SCADIA not available in functionGlobalContext", msg);
                    return done && done();
                }

                const uiTag = (typeof config.tag === "string") ? config.tag.trim() : "";
                const topicTag = (typeof msg.topic === "string") ? msg.topic.trim() : "";
                const tagRef = uiTag || topicTag;
                let tagId = config.tagId || null;

                // Keep master behavior (prefer configured tagId), then fallback to UI tag/topic lookup.
                if (!tagId && !tagRef) {
                    node.error("No tag provided: set Tag in the node OR provide msg.topic", msg);
                    return done && done();
                }

                if (!tagId) {
                    tagId = scadia.getTagId(tagRef, null);
                }

                if (!tagId) {
                    node.error("Tag not found: " + tagRef, msg);
                    return done && done();
                }

                const value = scadia.getTag(tagId);

                msg.payload = value;
                if (tagRef) {
                    msg.topic = tagRef;
                } else if (typeof config.tag === "string" && config.tag.trim()) {
                    msg.topic = config.tag.trim();
                }

                send(msg);
                return done && done();
            } catch (err) {
                node.error(err, msg);
                return done && done(err);
            }
        });
    }

    RED.nodes.registerType("get-tag", ScadiaGetTagNode);
};
