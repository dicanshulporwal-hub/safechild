import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import url from 'url';
import { authService } from './auth.service';
import { db } from '../db/store';

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
}

export class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private connections: Set<ClientConnection> = new Set();

  public init(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req) => {
      const parsedUrl = url.parse(req.url || '', true);
      const token = parsedUrl.query.token as string | undefined;
      const deviceToken = parsedUrl.query.deviceToken as string | undefined;
      const deviceId = parsedUrl.query.deviceId as string | undefined;

      const clientInfo: ClientConnection = {
        ws,
        type: 'parent',
        authenticated: false,
      };

      // 1. Check if token provided in URL query string
      if (token) {
        try {
          const decoded = authService.verifyToken(token);
          clientInfo.parentId = decoded.userId;
          clientInfo.authenticated = true;
          clientInfo.type = 'parent';
        } catch (e) {
          // invalid token
        }
      } else if (deviceToken && deviceId) {
        const device = db.devices.get(deviceId);
        if (device && device.deviceToken === deviceToken) {
          clientInfo.deviceId = device.id;
          clientInfo.childId = device.childId;
          clientInfo.parentId = device.parentId;
          clientInfo.authenticated = true;
          clientInfo.type = 'device';
        }
      }

      this.connections.add(clientInfo);

      // Authenticate message handler
      ws.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'AUTH_PARENT' || msg.type === 'REGISTER') {
            const authToken = msg.token || msg.jwt;
            if (authToken) {
              try {
                const decoded = authService.verifyToken(authToken);
                clientInfo.parentId = decoded.userId;
                clientInfo.childId = msg.childId;
                clientInfo.type = 'parent';
                clientInfo.authenticated = true;
                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', parentId: decoded.userId }));
              } catch (e) {
                ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Invalid JWT token' }));
              }
            } else if (msg.parentId && !clientInfo.authenticated) {
              // Backward compatible registration if already authenticated or in dev
              clientInfo.childId = msg.childId;
            }
          } else if (msg.type === 'AUTH_DEVICE') {
            const { deviceId: dId, deviceToken: dTok } = msg;
            const device = db.devices.get(dId);
            if (device && device.deviceToken === dTok) {
              clientInfo.deviceId = device.id;
              clientInfo.childId = device.childId;
              clientInfo.parentId = device.parentId;
              clientInfo.type = 'device';
              clientInfo.authenticated = true;
              ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', deviceId: device.id }));
            } else {
              ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Invalid device credentials' }));
            }
          }
        } catch (e) {}
      });

      ws.on('close', () => {
        this.connections.delete(clientInfo);
      });
    });
  }

  public broadcast(message: SocketMessage) {
    const payload = JSON.stringify(message);

    for (const conn of this.connections) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;

      // Only send to authenticated connections
      // If message is restricted to a parent, enforce tenancy
      if (message.parentId && conn.parentId && conn.parentId !== message.parentId) {
        continue;
      }
      if (message.childId && conn.childId && conn.childId !== message.childId) {
        continue;
      }
      if (message.deviceId && conn.deviceId && conn.deviceId !== message.deviceId) {
        continue;
      }

      conn.ws.send(payload);
    }
  }
}

export const wsManager = new WebSocketManager();
