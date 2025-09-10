import passport from "passport";
import jwt from "jsonwebtoken";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { getBoundDeviceId, bindDeviceId, unbindDeviceId } from "./device-lock";
import { User as SelectUser, insertUserSchema } from "@shared/schema";
import { z } from "zod";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const scryptAsync = promisify(scrypt);

async function createTestEmployee() {
  try {
    const existingUser = await storage.getUserByUsername("test");
    if (!existingUser) {
      const hashedPassword = await hashPassword("test");
      await storage.createUser({
        username: "test",
        password: hashedPassword,
        role: "employee",
        employeeId: "EMP001",
        department: "Testing",
      });
      console.log('✅ Test employee created: username=test, password=test');
    }
  } catch (error) {
    console.log('ℹ️ Test employee creation skipped (database not ready)');
  }
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string) {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

export function setupAuth(app: Express) {
  // Create test employee on startup
  createTestEmployee();

  const corsEnabled = !!process.env.CORS_ORIGIN;
  const cookieSameSite = (process.env.COOKIE_SAMESITE as any) || (corsEnabled ? 'none' : 'lax');
  // If SameSite=None, cookie must be Secure
  const cookieSecure = (process.env.COOKIE_SECURE === 'true') || (cookieSameSite === 'none') || (process.env.NODE_ENV === 'production');

  const sessionDays = parseInt(process.env.SESSION_MAX_AGE_DAYS || '30', 10);
  const sessionMaxAgeMs = Math.max(1, sessionDays) * 24 * 60 * 60 * 1000;

  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || "bedi-enterprises-secret-key-2025",
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      secure: cookieSecure,
      sameSite: cookieSameSite as any,
      httpOnly: true,
      maxAge: sessionMaxAgeMs,
    },
  };

  const sessionMiddleware = session(sessionSettings);

  app.set("trust proxy", 1);
  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  // Bearer token fallback: allow Authorization: Bearer <jwt> to authenticate
  // This enables Android app usage over HTTP (LAN) without relying on cookies.
  app.use((req, res, next) => {
    try {
      // If already authenticated via session, continue
      if (typeof req.isAuthenticated === 'function' && req.isAuthenticated()) {
        return next();
      }
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer ")) return next();
      const token = auth.slice(7);
      const secret = process.env.JWT_SECRET || "upload-secret-2025";
      const payload: any = jwt.verify(token, secret);
      if (!payload?.sub) return next();
      // Enforce device binding if configured
      const deviceLock = (process.env.DEVICE_LOCK || 'true').toLowerCase() !== 'false';
      const boundDid = deviceLock ? getBoundDeviceId(payload.sub) : undefined;
      const tokenDid = (payload as any).did as string | undefined;
      if (deviceLock && boundDid && tokenDid && boundDid !== tokenDid) {
        return next(); // reject bearer auth silently if device mismatch
      }

      storage.getUser(payload.sub)
        .then((user) => {
          if (user) {
            (req as any).user = user;
            // Monkey-patch to satisfy downstream checks
            (req as any).isAuthenticated = () => true;
          }
        })
        .finally(() => next());
    } catch {
      return next();
    }
  });

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        const user = await storage.getUserByUsername(username);
        if (!user || !(await comparePasswords(password, user.password))) {
          return done(null, false, { message: "Invalid username or password" });
        }
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }),
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id: string, done) => {
    try {
      // Handle admin user separately since it's not in database
      if (id === "admin-user") {
        const adminUser: SelectUser = {
          id: "admin-user",
          username: "bediAdmin",
          password: "",
          role: "admin",
          employeeId: null,
          department: null,
          joinDate: null,
          isActive: true,
          isLoggedIn: false,
          createdAt: null,
        };
        return done(null, adminUser);
      }
      
      const user = await storage.getUser(id);
      if (!user) {
        return done(null, false);
      }
      done(null, user);
    } catch (error) {
      console.error('Deserialize user error:', error);
      done(null, false); // Don't throw error, just return false
    }
  });

  // Employee registration disabled - only admin can create accounts

  app.post("/api/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: SelectUser | false, info: any) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ message: info?.message || "Invalid credentials" });
      }

      req.login(user, (err) => {
        if (err) return next(err);
        const deviceLock = (process.env.DEVICE_LOCK || 'true').toLowerCase() !== 'false';
        const deviceId = (req.headers['x-device-id'] as string) || (req.body?.deviceId as string) || undefined;
        try {
          if (deviceLock && deviceId) {
            const bound = getBoundDeviceId(user.id);
            if (bound && bound !== deviceId) {
              return res.status(403).json({ message: "Account already linked to a different device" });
            }
            if (!bound) {
              bindDeviceId(user.id, deviceId);
            }
          }
        } catch {}
        // Also issue a short-lived upload token to enable Android native uploads
        let token: string | undefined = undefined;
        try {
          if (user.role === "employee") {
            const secret = process.env.JWT_SECRET || "upload-secret-2025";
            const expiresIn = process.env.JWT_EXPIRES_IN || "180d";
            const payload: any = { sub: user.id, role: user.role };
            if (deviceId) payload.did = deviceId;
            token = jwt.sign(payload, secret, { expiresIn });
          }
        } catch {}
        // Do not enforce or update an "already logged in" flag
        res.status(200).json({ ...user, token });
      });
    })(req, res, next);
  });

  app.post("/api/logout", (req, res, next) => {
    const userId = req.user?.id;
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    res.json(req.user);
  });

  // Issue short-lived JWT for background/native uploads
  app.post("/api/auth/upload-token", (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    if (req.user?.role !== "employee") return res.status(403).json({ message: "Employee token only" });
    const secret = process.env.JWT_SECRET || "upload-secret-2025";
    const expiresIn = process.env.JWT_EXPIRES_IN || "180d";
    const deviceLock = (process.env.DEVICE_LOCK || 'true').toLowerCase() !== 'false';
    const deviceId = (req.headers['x-device-id'] as string) || undefined;
    if (deviceLock) {
      const bound = getBoundDeviceId(req.user.id);
      if (bound && deviceId && bound !== deviceId) {
        return res.status(403).json({ message: "Account linked to a different device" });
      }
      if (!bound && deviceId) bindDeviceId(req.user.id, deviceId);
    }
    const payload: any = { sub: req.user.id, role: req.user.role };
    if (deviceId) payload.did = deviceId;
    const token = jwt.sign(payload, secret, { expiresIn });
    res.json({ token });
  });

  // Admin login endpoint
  app.post("/api/admin/login", async (req, res, next) => {
    const { username, password, audioPassword } = req.body;
    
    try {
      if (username !== "bediAdmin" || password !== "bediMain2025") {
        return res.status(401).json({ message: "Invalid admin credentials" });
      }

      // Create a mock admin user for session
      const adminUser: SelectUser = {
        id: "admin-user",
        username: "bediAdmin",
        password: "", // Don't store actual password
        role: "admin",
        employeeId: null,
        department: null,
        joinDate: null,
        isActive: true,
        isLoggedIn: false,
        createdAt: null,
      };

      req.login(adminUser, (err) => {
        if (err) return next(err);
        
        // Store audio access in session if provided
        if (audioPassword === "audioAccess2025") {
          (req.session as any).audioAccess = true;
          (req.session as any).audioAccessTime = Date.now();
        }
        
        res.status(200).json(adminUser);
      });
    } catch (error) {
      next(error);
    }
  });

  // Audio access verification
  app.post("/api/admin/audio-access", (req, res) => {
    if (!req.isAuthenticated() || req.user?.role !== "admin") {
      return res.status(401).json({ message: "Admin access required" });
    }

    const { audioPassword } = req.body;
    if (audioPassword !== "audioAccess2025") {
      return res.status(401).json({ message: "Invalid audio access password" });
    }

    (req.session as any).audioAccess = true;
    (req.session as any).audioAccessTime = Date.now();
    res.status(200).json({ success: true });
  });

  // Middleware to check audio access
  app.use("/api/admin/audio", (req, res, next) => {
    if (!req.isAuthenticated() || req.user?.role !== "admin") {
      return res.status(401).json({ message: "Admin access required" });
    }

    const session = req.session as any;
    const now = Date.now();
    const audioAccessTime = session.audioAccessTime;
    const thirtyMinutes = 30 * 60 * 1000;

    if (!session.audioAccess || !audioAccessTime || (now - audioAccessTime) > thirtyMinutes) {
      return res.status(401).json({ message: "Audio access expired or not granted" });
    }

    next();
  });

  // Admin: unbind/reset device for a user
  app.post("/api/admin/reset-device/:userId", (req, res) => {
    if (!req.isAuthenticated() || req.user?.role !== "admin") {
      return res.status(401).json({ message: "Admin access required" });
    }
    const { userId } = req.params as any;
    try {
      unbindDeviceId(userId);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ message: (e as Error).message || 'Failed to reset device' });
    }
  });
  return sessionMiddleware;
}
