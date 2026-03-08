export class BaseVoiceAdapter {
  constructor(name) {
    this.name = name;
  }

  async createOutboundCall(_input) {
    throw new Error('Not implemented');
  }

  async hangup(_input) {
    throw new Error('Not implemented');
  }
}
