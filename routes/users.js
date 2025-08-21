const express = require("express");
const { body, validationResult } = require("express-validator");
const User = require("../models/User");
const { auth, authorize } = require("../middleware/auth");

const router = express.Router();

// GET /users  (Admin: all, Teacher: student+teacher, Student: denied)
router.get("/", auth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page ?? "1", 10) || 1);
    const limitNum = parseInt(req.query.limit ?? "10", 10);
    const limit = Math.min(
      100,
      Math.max(1, Number.isNaN(limitNum) ? 10 : limitNum)
    );

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const requestedRole =
      typeof req.query.role === "string"
        ? req.query.role.trim().toLowerCase()
        : null;

    if (req.user.role === "student") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    // what roles is the requester allowed to see?
    const visibleRoles =
      req.user.role === "teacher"
        ? ["student", "teacher"]
        : ["student", "teacher", "admin"]; // admin

    const query = {};

    if (requestedRole) {
      if (visibleRoles.includes(requestedRole)) {
        query.role = requestedRole;
      } else {
        query.role = [];
      }
    } else {
      query.role = { $in: visibleRoles };
    }

    // text search
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    // query + count in parallel
    const [users, total] = await Promise.all([
      User.find(query)
        .select("-password -resetPasswordToken -resetPasswordExpires")
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .skip((page - 1) * limit)
        .lean(),
      User.countDocuments(query),
    ]);

    return res.json({
      success: true,
      data: users,
      pagination: {
        total,
        perPage: limit,
        currentPage: page,
        totalPages: Math.ceil(total / limit),
      },
      // echo back applied filters (useful for clients)
      appliedFilters: {
        role: query.role,
        search: search || null,
      },
    });
  } catch (error) {
    console.error("❌ GET /users error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

// Get user by ID
router.get("/:id", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("-password -resetPasswordToken -resetPasswordExpires")
      .populate("quizzesCreated questionsCreated");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Students can only view their own profile
    if (
      req.user.role === "student" &&
      req.user._id.toString() !== user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

// Create user (Admin only)
router.post(
  "/",
  auth,
  authorize("admin"),
  [
    body("name").trim().isLength({ min: 2, max: 50 }),
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 6 }),
    body("role").isIn(["admin", "teacher", "student"]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation errors",
          errors: errors.array(),
        });
      }

      const { name, email, password, role } = req.body;

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: "User already exists with this email",
        });
      }

      const user = new User({
        name,
        email,
        password,
        role,
      });

      await user.save();

      res.status(201).json({
        success: true,
        message: "User created successfully",
        user,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Server error",
        error: error.message,
      });
    }
  }
);

// Update user
router.put("/:id", auth, async (req, res) => {
  try {
    const { name, email } = req.body;

    // Students can only update their own profile
    if (
      req.user.role === "student" &&
      req.user._id.toString() !== req.params.id
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    // Teachers can only update their own profile
    if (
      req.user.role === "teacher" &&
      req.user._id.toString() !== req.params.id
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    const updateData = { name, email };

    const user = await User.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    }).select("-password -resetPasswordToken -resetPasswordExpires");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      message: "User updated successfully",
      user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

// Delete user (Admin only)
router.delete("/:id", auth, authorize("admin"), async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

module.exports = router;
