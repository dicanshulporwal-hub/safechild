import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import url from 'url';
import { authService } from './auth.service';
import { prisma } from '../db/prisma';

export type SocketEventType =
  | 'POLICY_UPDATED'
  | 'ACCESS_REQUEST_CREATED'
  | 'ACCESS_REQUEST_RESOLVED'
  | 'DEVICE_HEALTH_CHANGED'
  | 'DEVICE_PAIRED'
  | 'DEVICE_REVOKED'
  | 'NOTIFICATION_CREATED'
  | 'TIMELINE_EVENT'
  | 'USAGE_UPDATED'
  | 'ACTIVITY_LOGGED';

export interface SocketMessage {
  type: SocketEventType;
  payload: any;
  childId?: string;
  parentId?: string;
  deviceId?: string;
}

interface ClientConnection {
  ws: WebSocket;
  parentId?: string;
  childId?: string;
  deviceId?: string;
  type: 'parent' | 'device';
  authenticated: boolean;
  authTimeoutTimer?: NodeJS.Timeout;
}

export class WebSocketManager {
  private static readonly AUTH_TIMEOUT_MS = 5000;
  private wss: WebSocketServer | null = null;
  private connections: Set<ClientConnection> = new Set();

  public init(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', async (ws: WebSocket, req) => {
      const parsedUrl = url.parse(req.url || '', true);
      const token = parsedUrl.query.token as string | undefined;
      const deviceToken = parsedUrl.query.deviceToken as string | undefined;
      const deviceId = parsedUrl.query.deviceId as string | undefined;

      const clientInfo: ClientConnection = {
        ws,
        type: 'parent',
        authenticated: false,
      };

      const markAuthenticated = () => {
        clientInfo.authenticated = true;
        if (clientInfo.authTimeoutTimer) {
          clearTimeout(clientInfo.authTimeoutTimer);
          clientInfo.authTimeoutTimer = undefined;
        }
      };

      // Set short authentication timeout to disconnect unauthenticated sockets
      clientInfo.authTimeoutTimer = setTimeout(() => {
        if (!clientInfo.authenticated) {
          try {
            ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Authentication timeout' }));
            ws.close(4001, 'Authentication timeout');
          } catch (e) {}
        }
      }, WebSocketManager.AUTH_TIMEOUT_MS);

      // 1. Legacy query-string authentication compatibility (if credentials supplied in URL)
      if (token) {
        try {
          const decoded = await authService.verifyToken(token);
          clientInfo.parentId = decoded.userId;
          clientInfo.type = 'parent';
          markAuthenticated();
        } catch (e) {
          // invalid token
        }
      } else if (deviceToken && deviceId) {
        try {
          const device = await prisma.device.findUnique({
            where: { id: deviceId },
          });
          if (device && device.deviceToken === deviceToken && !device.isRevoked) {
            clientInfo.deviceId = device.id;
            clientInfo.childId = device.childId;
            clientInfo.parentId = device.parentId;
            clientInfo.type = 'device';
            markAuthenticated();
          }
        } catch (e) {}
      }

      this.connections.add(clientInfo);

      // Authenticate message handler
      ws.on('message', async (data: string) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'AUTH_PARENT' || msg.type === 'REGISTER') {
            const authToken = msg.token || msg.jwt;
            if (authToken && typeof authToken === 'string') {
              try {
                const decoded = await authService.verifyToken(authToken);
                clientInfo.parentId = decoded.userId;
                clientInfo.childId = msg.childId;
                clientInfo.type = 'parent';
                markAuthenticated();
                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', parentId: decoded.userId }));
              } catch (e) {
                ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Authentication failed' }));
              }
            } else {
              ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Authentication failed' }));
            }
          } else if (msg.type === 'AUTH_DEVICE') {
            const { deviceId: dId, deviceToken: dTok } = msg;
            if (!dId || !dTok || typeof dId !== 'string' || typeof dTok !== 'string') {
              ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Authentication failed' }));
              return;
            }
            try {
              const device = await prisma.device.findUnique({
                where: { id: dId },
              });
              if (device && device.deviceToken === dTok && !device.isRevoked) {
                clientInfo.deviceId = device.id;
                clientInfo.childId = device.childId;
                clientInfo.parentId = device.parentId;
                clientInfo.type = 'device';
                markAuthenticated();
                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', deviceId: device.id }));
              } else {
                ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Authentication failed' }));
              }
            } catch (e) {
              ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Authentication failed' }));
            }
          }
        } catch (e) {}
      });

      const cleanup = () => {
        if (clientInfo.authTimeoutTimer) {
          clearTimeout(clientInfo.authTimeoutTimer);
          clientInfo.authTimeoutTimer = undefined;
        }
        this.connections.delete(clientInfo);
      };

      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
  }

  public broadcast(message: SocketMessage) {
    const payload = JSON.stringify(message);

    for (const conn of this.connections) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;

      // An unauthenticated connection MUST NOT receive ANY protected payload!
      if (!conn.authenticated) {
        continue;
      }

      if (message.parentId && conn.parentId && conn.parentId !== message.parentId) {
        continue;
      }
      if (message.childId) {
        if (conn.type === 'device' && conn.childId !== message.childId) {
          continue;
        }
        if (conn.type === 'parent' && conn.childId && conn.childId !== message.childId) {
          continue;
        }
      }
      if (message.deviceId) {
        if (conn.type === 'device' && conn.deviceId !== message.deviceId) {
          continue;
        }
      }

      try {
        conn.ws.send(payload);
      } catch (e) {}
    }
  }

  public getActiveConnectionCount(): number {
    return this.connections.size;
  }

  public getAuthenticatedConnectionCount(): number {
    let count = 0;
    for (const conn of this.connections) {
      if (conn.authenticated) count++;
    }
    return count;
  }
}

export const wsManager = new WebSocketManager();
