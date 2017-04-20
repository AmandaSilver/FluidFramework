import * as kafka from "kafka-node";
import * as _ from "lodash";
import * as minio from "minio";
import { MongoClient } from "mongodb";
import * as nconf from "nconf";
import * as redis from "redis";
import * as socketIo from "socket.io";
import * as socketIoRedis from "socket.io-redis";
import { Readable } from "stream";
import * as api from "../api";
import * as socketStorage from "../socket-storage";

let io = socketIo();

// Group this into some kind of an interface
const zookeeperEndpoint = nconf.get("zookeeper:endpoint");
const kafkaClientId = nconf.get("alfred:kafkaClientId");
const topic = nconf.get("alfred:topic");
const bucket = nconf.get("alfred:bucket");

let kafkaClient = new kafka.Client(zookeeperEndpoint, kafkaClientId);
let producer = new kafka.Producer(kafkaClient, { partitionerType: 3 });
let producerReady = new Promise<void>((resolve, reject) => {
    producer.on("ready", () => {
        kafkaClient.refreshMetadata(["rawdeltas"], (error, data) => {
            if (error) {
                console.error(error);
                return reject();
            }

            return resolve();
        });
    });
});

producer.on("error", (error) => {
    console.error("ERROR CONNECTEING TO KAFKA");
    console.error(error);
});

// Setup redis
let host = nconf.get("redis:host");
let port = nconf.get("redis:port");
let pass = nconf.get("redis:pass");

let options: any = { auth_pass: pass };
if (nconf.get("redis:tls")) {
    options.tls = {
        servername: host,
    };
}

let pubOptions = _.clone(options);
let subOptions = _.clone(options);

let pub = redis.createClient(port, host, pubOptions);
let sub = redis.createClient(port, host, subOptions);
io.adapter(socketIoRedis({ pubClient: pub, subClient: sub }));

// Connect to the database
const mongoUrl = nconf.get("mongo:endpoint");
const mongoClientP = MongoClient.connect(mongoUrl);
const collectionP = mongoClientP.then(async (db) => {
    const deltasCollectionName = nconf.get("mongo:collectionNames:deltas");
    const collection = db.collection(deltasCollectionName);
    return collection;
});

// Gain access to the document storage
const minioConfig = nconf.get("minio");
const minioClient = new minio.Client({
    accessKey: minioConfig.accessKey,
    endPoint: minioConfig.endpoint,
    port: minioConfig.port,
    secretKey: minioConfig.secretKey,
    secure: false,
});

/**
 * Retrieves the stored object
 */
async function getObject(objectId: string, bucket: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        minioClient.getObject(bucket, objectId, (error, stream: Readable) => {
            if (error) {
                return error.code === "NoSuchKey" ? resolve(null) : reject(error);
            }

            let object = "";

            // Set the encoding so that node does the conversion to a string
            stream.setEncoding("utf-8");
            stream.on("data", (chunk: string) => {
                object += chunk;
            });

            stream.on("end", () => {
                console.log(object);
                resolve(object);
            });

            stream.on("error", (streamError) => {
                reject(streamError);
            });
        });
    });
}

io.on("connection", (socket) => {
    // The loadObject call needs to see if the object already exists. If not it should offload to
    // the storage service to go and create it.
    //
    // If it does exist it should query that same service to pull in the current snapshot.
    //
    // Given a client is then going to send us deltas on that service we need routerlicious to kick in as well.
    socket.on("loadObject", (message: socketStorage.ILoadObjectMessage, response) => {
        // Join the room first to ensure the client will start receiving delta updates
        console.log(`Client has requested to load ${message.objectId}`);
        socket.join(message.objectId, (joinError) => {
            if (joinError) {
                return response({ error: joinError });
            }

            // Now grab the snapshot, any deltas post snapshot, and send to the client
            const resultP = getObject(message.objectId, bucket).then(async (text) => {
                let snapshot: api.ICollaborativeObjectSnapshot;
                if (text === null) {
                    snapshot = {
                        sequenceNumber: 0,
                        snapshot: {},
                    };
                } else {
                    snapshot = JSON.parse(text);
                }

                const collection = await collectionP;
                const deltas = await collection
                    .find({ objectId: message.objectId, sequenceNumber: { $gt: snapshot.sequenceNumber } })
                    .sort({ sequenceNumber: 1 })
                    .toArray();
                console.log("Found outstanding deltas");
                console.log(JSON.stringify(deltas, null, 2));

                const responseMessage: socketStorage.IResponse<socketStorage.IObjectDetails> = {
                    data: {
                        deltas,
                        id: message.objectId,
                        sequenceNumber: snapshot.sequenceNumber,
                        snapshot: snapshot.snapshot,
                        type: message.type,
                    },
                    error: null,
                };

                return responseMessage;
            });

            resultP.then(
                (responseMessage) => response(responseMessage),
                (error) => response({ error }));
        });
    });

    // Message sent when a new operation is submitted to the router
    socket.on("submitOp", (message: socketStorage.ISubmitOpMessage, response) => {
        console.log(`Operation received for object ${message.objectId}`);

        let submittedP = producerReady.then(() => {
            const payloads = [{ topic, messages: [JSON.stringify(message)], key: message.objectId }];
            return new Promise<any>((resolve, reject) => {
                producer.send(payloads, (error, data) => {
                    if (error) {
                        return reject(error);
                    }

                    console.log(data);
                    resolve({ data: true });
                });
            });
        });

        submittedP.then(
            (responseMessage) => response(responseMessage),
            (error) => ({ error }));
    });
});

export default io;
