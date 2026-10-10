import mongoose from 'mongoose';
import { allModels } from './models';

export async function connectDatabase(uri: string, dbName?: string): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, dbName });
  // Create collections and indexes up front: transactions can't create them implicitly.
  await Promise.all(allModels.map((m) => m.createCollection().then(() => m.syncIndexes())));
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
