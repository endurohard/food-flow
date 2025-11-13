import { Request, Response, NextFunction } from 'express';
import { EnterpriseService } from '../services/enterprise.service';

// Extend Express Request type to include enterprise context
declare global {
  namespace Express {
    interface Request {
      enterpriseId?: string;
      userId?: string;
      userRole?: string;
      userPermissions?: any;
    }
  }
}

/**
 * Middleware to validate and inject enterprise context into request
 * Expects either:
 * - Header: X-Enterprise-ID
 * - Query param: enterpriseId
 * - User's default enterprise from JWT
 */
export const enterpriseContext = (enterpriseService: EnterpriseService) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get enterprise ID from different sources
      const enterpriseId =
        req.headers['x-enterprise-id'] as string ||
        req.query.enterpriseId as string ||
        req.body.enterpriseId;

      // Get user ID from JWT (assuming it's already set by auth middleware)
      const userId = req.userId;

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      // If no enterprise ID provided, get user's primary enterprise
      if (!enterpriseId) {
        const userEnterprises = await enterpriseService.getUserEnterprises(userId);

        if (userEnterprises.length === 0) {
          return res.status(403).json({
            error: 'No enterprise access',
            message: 'User does not belong to any enterprise'
          });
        }

        // Use first active enterprise
        req.enterpriseId = userEnterprises[0].enterprise_id;
        req.userRole = userEnterprises[0].user_role;
      } else {
        // Verify user has access to the specified enterprise
        const hasAccess = await enterpriseService.checkUserAccess(
          userId,
          enterpriseId
        );

        if (!hasAccess) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'User does not have access to this enterprise'
          });
        }

        req.enterpriseId = enterpriseId;
      }

      next();
    } catch (error) {
      console.error('Enterprise context middleware error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to establish enterprise context'
      });
    }
  };
};

/**
 * Middleware to require specific roles for enterprise access
 */
export const requireEnterpriseRole = (...allowedRoles: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, enterpriseId, userRole } = req;

      if (!userId || !enterpriseId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing authentication or enterprise context'
        });
      }

      if (!userRole || !allowedRoles.includes(userRole)) {
        return res.status(403).json({
          error: 'Forbidden',
          message: `Requires one of the following roles: ${allowedRoles.join(', ')}`,
          requiredRoles: allowedRoles,
          userRole
        });
      }

      next();
    } catch (error) {
      console.error('Role check middleware error:', error);
      return res.status(500).json({
        error: 'Internal server error'
      });
    }
  };
};

/**
 * Middleware to require specific permissions
 */
export const requirePermission = (...requiredPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userPermissions, userRole } = req;

      // Owners and admins have all permissions
      if (userRole === 'owner' || userRole === 'admin') {
        return next();
      }

      if (!userPermissions) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'User has no permissions assigned'
        });
      }

      // Check if user has all required permissions
      const hasAllPermissions = requiredPermissions.every(
        (permission) => userPermissions[permission] === true
      );

      if (!hasAllPermissions) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions',
          required: requiredPermissions
        });
      }

      next();
    } catch (error) {
      console.error('Permission check middleware error:', error);
      return res.status(500).json({
        error: 'Internal server error'
      });
    }
  };
};

/**
 * Simple JWT auth middleware (placeholder - implement with actual JWT library)
 */
export const authenticateUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header'
      });
    }

    const token = authHeader.substring(7);

    // TODO: Implement actual JWT verification
    // For now, this is a placeholder
    // const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // req.userId = decoded.userId;

    // Temporary: extract user ID from token (implement proper JWT)
    req.userId = 'temp-user-id';

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }
};

/**
 * Middleware to set PostgreSQL session variable for Row Level Security
 */
export const setRLSContext = () => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.userId) {
      // This will be used by RLS policies
      res.locals.userId = req.userId;
    }
    next();
  };
};
