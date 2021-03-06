import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  execute,
  subscribe,
  GraphQLNonNull,
} from 'graphql';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import net from 'net';
import http from 'http';
import { createServer, ServerOptions, Server } from '../../server';

// distinct server for each test; if you forget to dispose, the fixture wont
const leftovers: Dispose[] = [];
afterEach(async () => {
  while (leftovers.length > 0) {
    // if not disposed by test, cleanup
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const dispose = leftovers.pop()!;
    await dispose();
  }
});

export interface TServer {
  url: string;
  server: Server;
  clients: Set<WebSocket>;
  pong: (key?: string) => void;
  waitForClient: (
    test?: (client: WebSocket) => void,
    expire?: number,
  ) => Promise<void>;
  waitForOperation: (test?: () => void, expire?: number) => Promise<void>;
  waitForClientClose: (test?: () => void, expire?: number) => Promise<void>;
  dispose: Dispose;
}

type Dispose = (beNice?: boolean) => Promise<void>;

// use for dispatching a `pong` to the `ping` subscription
const pendingPongs: Record<string, number | undefined> = {};
const pongListeners: Record<string, ((done: boolean) => void) | undefined> = {};
function pong(key = 'global'): void {
  if (pongListeners[key]) {
    pongListeners[key]?.(false);
  } else {
    const pending = pendingPongs[key];
    pendingPongs[key] = pending ? pending + 1 : 1;
  }
}

export const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      getValue: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: () => 'value',
      },
    },
  }),
  subscription: new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      greetings: {
        type: new GraphQLNonNull(GraphQLString),
        subscribe: async function* () {
          for (const hi of ['Hi', 'Bonjour', 'Hola', 'Ciao', 'Zdravo']) {
            yield { greetings: hi };
          }
        },
      },
      ping: {
        type: new GraphQLNonNull(GraphQLString),
        args: {
          key: {
            type: GraphQLString,
          },
        },
        subscribe: function (_src, args) {
          const key = args.key ? args.key : 'global';
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              if ((pendingPongs[key] ?? 0) > 0) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                pendingPongs[key]!--;
                return { value: { ping: 'pong' } };
              }
              if (
                await new Promise((resolve) => (pongListeners[key] = resolve))
              ) {
                return { done: true };
              }
              return { value: { ping: 'pong' } };
            },
            async return() {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              pongListeners[key]!(true);
              delete pongListeners[key];
              return { done: true };
            },
            async throw() {
              throw new Error('Ping no gusta');
            },
          };
        },
      },
    },
  }),
});

// test server finds an open port starting the search from this one
const startPort = 8765;

export async function startTServer(
  options: Partial<ServerOptions> = {},
): Promise<TServer> {
  const path = '/simple';
  const emitter = new EventEmitter();

  // prepare http server
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  // http sockets to kick off on teardown
  const sockets = new Set<net.Socket>();
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    httpServer.once('close', () => sockets.delete(socket));
  });

  // create server and hook up for tracking operations
  let pendingOperations = 0;
  const server = await createServer(
    {
      schema,
      execute,
      subscribe,
      ...options,
      onOperation: async (ctx, msg, args, result) => {
        pendingOperations++;
        const maybeResult = await options?.onOperation?.(
          ctx,
          msg,
          args,
          result,
        );
        emitter.emit('operation');
        return maybeResult;
      },
    },
    {
      server: httpServer,
      path,
    },
  );

  // search for open port from the starting port
  let port = startPort;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.once('listening', resolve);
        httpServer.listen(port);
      });
      break; // listening
    } catch (err) {
      if ('code' in err && err.code === 'EADDRINUSE') {
        port++;
        if (port - startPort > 256) {
          throw new Error(`Cant find open port, stopping search on ${port}`);
        }
        continue; // try another one if this port is in use
      } else {
        throw err; // throw all other errors immediately
      }
    }
  }

  // pending websocket clients
  let pendingCloses = 0;
  const pendingClients: WebSocket[] = [];
  server.webSocketServer.on('connection', (client) => {
    pendingClients.push(client);
    client.once('close', () => {
      pendingCloses++;
      emitter.emit('close');
    });
  });

  // disposes of all started servers
  const dispose: Dispose = (beNice) => {
    return new Promise((resolve, reject) => {
      if (!beNice) {
        for (const socket of sockets) {
          socket.destroy();
          sockets.delete(socket);
        }
      }
      const disposing = server.dispose() as Promise<void>;
      disposing.catch(reject).then(() => {
        httpServer.close(() => {
          leftovers.splice(leftovers.indexOf(dispose), 1);
          resolve();
        });
      });
    });
  };
  leftovers.push(dispose);

  return {
    url: `ws://localhost:${port}${path}`,
    server,
    get clients() {
      return server.webSocketServer.clients;
    },
    pong,
    waitForClient(test, expire) {
      return new Promise((resolve) => {
        function done() {
          // the on connect listener below will be called before our listener, populating the queue
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const client = pendingClients.shift()!;
          test?.(client);
          resolve();
        }
        if (pendingClients.length > 0) {
          return done();
        }
        server.webSocketServer.once('connection', done);
        if (expire) {
          setTimeout(() => {
            server.webSocketServer.off('connection', done); // expired
            resolve();
          }, expire);
        }
      });
    },
    waitForOperation(test, expire) {
      return new Promise((resolve) => {
        function done() {
          pendingOperations--;
          test?.();
          resolve();
        }
        if (pendingOperations > 0) {
          return done();
        }
        emitter.once('operation', done);
        if (expire) {
          setTimeout(() => {
            emitter.off('operation', done); // expired
            resolve();
          }, expire);
        }
      });
    },
    waitForClientClose(test, expire) {
      return new Promise((resolve) => {
        function done() {
          pendingCloses--;
          test?.();
          resolve();
        }
        if (pendingCloses > 0) {
          return done();
        }
        emitter.once('close', done);
        if (expire) {
          setTimeout(() => {
            emitter.off('close', done); // expired
            resolve();
          }, expire);
        }
      });
    },
    dispose,
  };
}
