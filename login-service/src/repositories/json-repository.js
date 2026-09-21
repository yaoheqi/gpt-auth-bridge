import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class JsonRepository {
  constructor(filePath, { defaultValue } = {}) {
    this.filePath = path.resolve(filePath);
    this.defaultValue = defaultValue;
    this.writeQueue = Promise.resolve();
  }

  async read({ create = false } = {}) {
    try { return JSON.parse(await fs.readFile(this.filePath, 'utf8')); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const value = typeof this.defaultValue === 'function' ? this.defaultValue() : structuredClone(this.defaultValue);
      if (create) await this.write(value);
      return value;
    }
  }

  async write(value) {
    const operation = this.writeQueue.then(() => writeJsonAtomic(this.filePath, value));
    this.writeQueue = operation.catch(() => {});
    await operation;
    return value;
  }
}
