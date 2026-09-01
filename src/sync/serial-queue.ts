export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  get size(): number {
    return this.queued;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const result = this.tail.then(operation, operation);
    this.tail = result.finally(() => {
      this.queued -= 1;
    });
    return result;
  }

  async idle(): Promise<void> {
    await this.tail;
  }
}

export class KeyedSerialQueue {
  private readonly queues = new Map<string, SerialQueue>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(key) ?? new SerialQueue();
    this.queues.set(key, queue);
    return queue.run(operation).finally(() => {
      if (queue.size === 0) this.queues.delete(key);
    });
  }

  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.idle()));
  }
}
