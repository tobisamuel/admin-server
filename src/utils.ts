import { MongoClient } from "mongodb";

let MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error(
    "Please define the MONGODB_URI environment variable inside .env"
  );
}

const client: MongoClient = await MongoClient.connect(MONGODB_URI);

const db = client.db("alma-db");

export { db };
