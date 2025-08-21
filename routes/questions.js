
const express = require('express');
const { body, validationResult } = require('express-validator');
const Question = require('../models/Question');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// Get all questions
router.get('/', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const { subject, difficulty, search, page = 1, limit = 10 } = req.query;
    
    let query = {};
    
    // Teachers can only see their own questions unless they're admin
    if (req.user.role === 'teacher') {
      query.createdBy = req.user._id;
    }
    
    if (subject) query.subject = subject;
    if (difficulty) query.difficulty = difficulty;
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { questionText: { $regex: search, $options: 'i' } }
      ];
    }

    const questions = await Question.find(query)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Question.countDocuments(query);

    res.json({
      success: true,
      questions,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Get question by ID
router.get('/:id', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const question = await Question.findById(req.params.id)
      .populate('createdBy', 'name email');

    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    // Teachers can only view their own questions unless they're admin
    if (req.user.role === 'teacher' && question.createdBy._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      question
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Create question
router.post('/', auth, authorize('admin', 'teacher'), [
  body('title').trim().isLength({ min: 5, max: 200 }),
  body('questionText').isLength({ min: 10 }),
  body('questionType').isIn(['multiple-choice', 'true-false', 'short-answer']),
  body('subject').isLength({ min: 2 }),
  body('difficulty').optional().isIn(['easy', 'medium', 'hard'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const questionData = {
      ...req.body,
      createdBy: req.user._id
    };

    // Validate options for multiple choice questions
    if (req.body.questionType === 'multiple-choice') {
      if (!req.body.options || req.body.options.length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Multiple choice questions must have at least 2 options'
        });
      }

      const correctOptions = req.body.options.filter(option => option.isCorrect);
      if (correctOptions.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one option must be marked as correct'
        });
      }
    }

    const question = new Question(questionData);
    await question.save();

    await question.populate('createdBy', 'name email');

    res.status(201).json({
      success: true,
      message: 'Question created successfully',
      question
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Update question
router.put('/:id', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const question = await Question.findById(req.params.id);

    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    // Teachers can only update their own questions
    if (req.user.role === 'teacher' && question.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    Object.assign(question, req.body);
    await question.save();

    await question.populate('createdBy', 'name email');

    res.json({
      success: true,
      message: 'Question updated successfully',
      question
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Delete question
router.delete('/:id', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const question = await Question.findById(req.params.id);

    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    // Teachers can only delete their own questions
    if (req.user.role === 'teacher' && question.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    await Question.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Question deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Get subjects (for dropdown lists)
router.get('/subjects/list', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const subjects = await Question.distinct('subject');
    res.json({
      success: true,
      subjects
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

module.exports = router;