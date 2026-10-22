const mongoose = require('mongoose');

async function connectDB(uri) {
  mongoose.set('strictQuery', true);
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log(`[db] connected: ${conn.connection.host}/${conn.connection.name}`);
  return conn;
}

module.exports = { connectDB };