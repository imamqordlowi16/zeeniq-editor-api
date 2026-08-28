require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const filmRoutes = require('./routes/filmRoutes');
const gamingRoutes = require('./routes/gamingRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB Atlas
connectDB();

app.use(cors());
app.use(express.json());

app.use('/api', filmRoutes);
app.use('/api', gamingRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
