const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;

const app = express();

// middleware
app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.6iupoas.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

function verifyJWT(req, res, next) {

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('unauthorized access');
    }

    const token = authHeader.split(' ')[1];

    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded;
        next();
    });
};

async function run() {
    try {
        const appointmentOptionsCollection = client.db('doctorsPortal').collection('appointmentOptions');
        const bookingsCollection = client.db('doctorsPortal').collection('bookings');
        const usersCollection = client.db('doctorsPortal').collection('users');
        const doctorsCollection = client.db('doctorsPortal').collection('doctors');
        const paymentsCollection = client.db('doctorsPortal').collection('payments');

        // NOTE: make sure you use verify admin after verify jwt
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' });
            };

            next();
        }

        // 
        // Use Aggregate to query multiple collection and then marge data
        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const query = {};
            const options = await appointmentOptionsCollection.find(query).toArray();
            const bookingQuery = { appointmentDate: date };
            const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

            // code carefully :D
            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
                const bookedSlots = optionBooked.map(book => book.slot);
                const remainningSlots = option.slots.filter(slot => !bookedSlots.includes(slot));
                option.slots = remainningSlots;
            })
            res.send(options);
        });

        //  //  //
        // app.get('/v2/appointmentOptions', async (req, res) => {
        //     const date = req.query;
        //     const options = await appointmentOptionsCollection.aggregate([
        //         {
        //             $lookup: {
        //                 from: 'bookings',
        //                 localField: 'name',
        //                 foreignField: 'treatment',
        //                 pipeline: [ 
        //                     {
        //                         $match: {
        //                             $expr: { 
        //                                 $ep: ['$appointmentDate', date]
        //                              }
        //                         }
        //                     }
        //                 ],
        //                 as: 'booked'
        //             }
        //         },
        //         {
        //             $project:{
        //                 name: 1,
        //                 slots: 1,
        //                 booked: {
        //                     $map: {
        //                         input: '$booked',
        //                         as: 'book',
        //                         in: '$$book.slot'
        //                     }
        //                 }
        //             }
        //         },
        //         {
        //             $project: {
        //                 name: 1,
        //                 slots: {
        //                     $setDifference: ['$slots', '$booked']
        //                 }
        //             }
        //         }
        //     ]).toArray();
        //     res.send(options);
        // })
        // //  //

        app.get('/appointmentSpeciality', async (req, res) => {
            const query = {};
            const result = await appointmentOptionsCollection.find(query).project({ name: 1, }).toArray();
            res.send(result);
        })

        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;

            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' });
            };

            const query = { email: email };
            const bookings = await bookingsCollection.find(query).toArray();
            res.send(bookings);
        });

        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const booking = await bookingsCollection.findOne(query);
            res.send(booking);
        })

        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            console.log(booking);
            const query = {
                appointmentDate: booking.appointmentDate,
                treatment: booking.treatment,
                email: booking.email
            }

            const alreadyBooked = await bookingsCollection.find(query).toArray();

            if (alreadyBooked.length) {
                const message = `you already have a booking on : ${booking.appointmentDate}`;
                return res.send({ acknowledge: false, message });
            }
            const result = await bookingsCollection.insertOne(booking);
            res.send(result);
        });

        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: 'usd',
                amount: amount,
                "payment_method_types": [
                    "card"
                ],
            })
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });

        app.post('/payments', async(req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId;
            const filter = {
                _id: new ObjectId(id)
            };
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            };
            const updatedResult = await bookingsCollection.updateOne(filter, updatedDoc, {upsert: true})
            res.send(result);
        })

        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1d' })
                return res.send({ accessToken: token });
            }
            res.status(403).send({ accessToken: '' })
        });

        app.get('/users', verifyJWT, async (req, res) => {
            const queryAllUsers = {};
            const decodedEmail = req.decoded.email;

            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send([]);
            }

            const users = await usersCollection.find(queryAllUsers).toArray();
            res.send(users);
        })

        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' });
        })

        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });

        app.put('/users/admin/:id', verifyJWT, async (req, res) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' });
            };

            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const options = { upsert: true };
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updatedDoc, options);
            res.send(result);
        });

        // temporaly to update price field on appoinment options
        // app.get('/addPrice', async (req, res) => {
        //     const filter = {};
        //     const options = { upsert: true }
        //     const updatedDoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }
        //     const result = await appointmentOptionsCollection.updateMany(filter, updatedDoc, options);
        //     res.send(result);
        // })

        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctors = await doctorsCollection.find(query).toArray();
            res.send(doctors);
        })

        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        })

        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        });

    } finally {

    }
}
run().catch(console.log);


app.get('/', (req, res) => {
    res.send('Doctors Portal server is running')
})

app.listen(port, () => console.log(`Doctors Portal Running on port: ${port}`))
