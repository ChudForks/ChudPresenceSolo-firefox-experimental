import { discordPresence } from '../discord/presence.js';

export const presencePublisher = Object.freeze({
  initialize() {
    return discordPresence.initialize();
  },

  status() {
    return discordPresence.status();
  },

  publish(intent, applicationId, options) {
    return discordPresence.publish(intent, applicationId, options);
  },

  connect() {
    return discordPresence.connect();
  },

  disconnect() {
    return discordPresence.disconnect();
  },

  async setup() {
    return discordPresence.getSetup();
  },

  renew() {
    return discordPresence.renew();
  },
});
