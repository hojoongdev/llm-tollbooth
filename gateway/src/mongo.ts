import { MongoClient, type Collection, type Db } from "mongodb";

import { MONGO_DB, MONGO_URI } from "./config.js";

let client: MongoClient | null = null;
let database: Db | null = null;

export async function connectMongo(): Promise<void> {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  database = client.db(MONGO_DB);
}

function db(): Db {
  if (!database) throw new Error("mongo: connectMongo() has not run");
  return database;
}

export function collection<T extends object>(name: string): Collection<T> {
  return db().collection<T>(name);
}

export function mongoReady(): boolean {
  return database !== null;
}

export async function closeMongo(): Promise<void> {
  await client?.close();
  client = null;
  database = null;
}
