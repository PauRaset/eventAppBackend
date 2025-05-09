const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  title: String,
  description: String,
  date: Date,
  city: String,
  street: String,
  postalCode: String,
  image: String,
  categories: [String], 
  age: String,
  dressCode: String,
  price: String, 
  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
});

module.exports = mongoose.model("Event", eventSchema);
