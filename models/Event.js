const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  title: String,
  description: String,
  date: Date,
  city: String,
  street: String,
  postalCode: String,
  image: String,
  categories: [String], // Ahora admite múltiples categorías
  age: String,
  dressCode: String, // Nuevo campo para Dress Code
  price: String, // Nuevo campo para el precio de la entrada
  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
});

module.exports = mongoose.model("Event", eventSchema);

/*const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  title: String,
  description: String,
  date: Date,
  city: String,
  street: String,
  postalCode: String,
  image: String,
  category: String,
  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  }, // Nuevo campo
});

module.exports = mongoose.model("Event", eventSchema);*/
