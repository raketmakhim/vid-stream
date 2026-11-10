const { DynamoDBClient, PutItemCommand, DeleteItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { verify, getParams, cleanMessage } = require('./lib');

const db = new DynamoDBClient({});
const TABLE = process.env.TABLE;

const forget = (id) => db.send(new DeleteItemCommand({ TableName: TABLE, Key: { id: { S: id } } }));

exports.handler = async (event) => {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;

  if (routeKey === '$connect') {
    const { 'hmac-secret': secret } = await getParams('hmac-secret');
    if (!verify(secret, event.queryStringParameters?.token)) return { statusCode: 401 };
    const ttl = String(Math.floor(Date.now() / 1000) + 3 * 3600); // stale rows expire; ws max life is 2h
    await db.send(new PutItemCommand({ TableName: TABLE, Item: { id: { S: connectionId }, ttl: { N: ttl } } }));
    return { statusCode: 200 };
  }

  if (routeKey === '$disconnect') {
    await forget(connectionId);
    return { statusCode: 200 };
  }

  // $default: relay a whitelisted message to every other connection
  let m;
  try { m = JSON.parse(event.body); } catch { return { statusCode: 400 }; }
  const msg = cleanMessage(m);
  if (!msg) return { statusCode: 200 }; // unknown types and pings

  const api = new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
  // shortcut: single Scan page, fine for a handful of connections.
  const { Items } = await db.send(new ScanCommand({ TableName: TABLE, ProjectionExpression: 'id', ConsistentRead: true }));
  await Promise.all(Items.filter((i) => i.id.S !== connectionId).map(async (i) => {
    try {
      await api.send(new PostToConnectionCommand({ ConnectionId: i.id.S, Data: JSON.stringify(msg) }));
    } catch (e) {
      if (e.name === 'GoneException' || e.$metadata?.httpStatusCode === 410) await forget(i.id.S);
      else throw e;
    }
  }));
  return { statusCode: 200 };
};
