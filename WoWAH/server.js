const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// New API route for the button
app.get('/api/external-data', async (req, res) => {
    try {
        const response = await axios.get('https://eu.api.blizzard.com/data/wow/auctions/commodities?namespace=dynamic-eu&locale=en_GB&access_token=EUJ6LQSZSzaMscfbwrfl4NZCbcH2xt8c4k'); // Replace with your actual API URL
        const data = response.data; // Assuming this is an array of entries

        // Grouping by id
        const groupedData = data.auctions.reduce((acc, item) => {
            const { id, quantity, unit_price } = item;
            if (!acc[id]) {
                acc[id] = { id, total_quantity: 0, total_unit_price: 0 };
            }
            acc[id].total_quantity += quantity;
            acc[id].total_unit_price += unit_price; // You may want to adjust aggregation logic
            return acc;
        }, {});

        // Convert the object back to an array
        const groupedArray = Object.values(groupedData);

        // Sorting the groups based on total_unit_price
        const sortedArray = groupedArray.sort((a, b) => b.total_unit_price - a.total_unit_price);

        res.json(sortedArray);
    } catch (error) {
        console.error('Error fetching data from external API:', error);
        res.status(500).json({ error: 'Error fetching data' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

// ('https://eu.api.blizzard.com/data/wow/auctions/commodities?namespace=dynamic-eu&locale=en_GB&access_token=EUJ6LQSZSzaMscfbwrfl4NZCbcH2xt8c4k'); // Example API