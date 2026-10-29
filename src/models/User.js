const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String, required: true, unique: true,
      trim: true, minlength: 3, maxlength: 32,
    },
    passwordHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'users', versionKey: false }
);

userSchema.statics.hashPassword = (pwd) => bcrypt.hash(pwd, 10);
userSchema.methods.verifyPassword = function (pwd) {
  return bcrypt.compare(pwd, this.passwordHash);
};
userSchema.methods.toSafeJSON = function () {
  return { id: this._id, username: this.username, createdAt: this.createdAt };
};

module.exports = mongoose.model('User', userSchema);