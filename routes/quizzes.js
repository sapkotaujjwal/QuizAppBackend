const express = require('express');
const { body, validationResult } = require('express-validator');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const QuizAttempt = require('../models/QuizAttempt');
const User = require('../models/User');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// Get all quizzes
router.get('/', auth, async (req, res) => {
  try {
    const { subject, isPublished, page = 1, limit = 10 } = req.query;
    
    let query = {};
    
    // Role-based filtering
    if (req.user.role === 'student') {
      query.isPublished = true;
      query.$or = [
        { allowedStudents: { $in: [req.user._id] } },
        { allowedStudents: { $size: 0 } } // Public quizzes
      ];
    } else if (req.user.role === 'teacher') {
      query.createdBy = req.user._id;
    }
    
    if (subject) query.subject = subject;
    if (isPublished !== undefined) query.isPublished = isPublished === 'true';

    const quizzes = await Quiz.find(query)
      .populate('createdBy', 'name email')
      .populate('questions', 'title difficulty')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Quiz.countDocuments(query);

    res.json({
      success: true,
      quizzes,
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

// Get quiz by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('questions')
      .populate('allowedStudents', 'name email');

    if (!quiz) {
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    // Check access permissions
    if (req.user.role === 'student') {
      if (!quiz.isPublished) {
        return res.status(403).json({
          success: false,
          message: 'Quiz is not published'
        });
      }

      if (quiz.allowedStudents.length > 0 && !quiz.allowedStudents.some(student => student._id.toString() === req.user._id.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }

      // For students, don't show correct answers
      quiz.questions = quiz.questions.map(q => ({
        ...q.toObject(),
        options: q.options ? q.options.map(opt => ({ text: opt.text, _id: opt._id })) : [],
        correctAnswer: undefined,
        explanation: undefined
      }));
    } else if (req.user.role === 'teacher' && quiz.createdBy._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Get user's previous attempts (for students)
    let userAttempts = [];
    if (req.user.role === 'student') {
      userAttempts = await QuizAttempt.find({
        quiz: quiz._id,
        student: req.user._id
      }).sort({ attemptNumber: -1 });
    }

    res.json({
      success: true,
      quiz,
      userAttempts
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Create quiz
router.post('/', auth, authorize('admin', 'teacher'), [
  body('title').trim().isLength({ min: 5, max: 200 }),
  body('subject').isLength({ min: 2 }),
  body('questions').isArray().isLength({ min: 1 }),
  body('timeLimit').optional().isInt({ min: 5, max: 300 }),
  body('maxAttempts').optional().isInt({ min: 1, max: 10 }),
  body('passingScore').optional().isInt({ min: 0, max: 100 })
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

    const { questions } = req.body;

    // Validate questions exist
    const questionDocs = await Question.find({ _id: { $in: questions } });
    if (questionDocs.length !== questions.length) {
      return res.status(400).json({
        success: false,
        message: 'Some questions not found'
      });
    }

    const quizData = {
      ...req.body,
      createdBy: req.user._id
    };

    const quiz = new Quiz(quizData);
    await quiz.save();

    await quiz.populate([
      { path: 'createdBy', select: 'name email' },
      { path: 'questions', select: 'title difficulty' }
    ]);

    res.status(201).json({
      success: true,
      message: 'Quiz created successfully',
      quiz
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Update quiz
router.put('/:id', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);

    if (!quiz) {
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    // Teachers can only update their own quizzes
    if (req.user.role === 'teacher' && quiz.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    Object.assign(quiz, req.body);
    await quiz.save();

    await quiz.populate([
      { path: 'createdBy', select: 'name email' },
      { path: 'questions', select: 'title difficulty' }
    ]);

    res.json({
      success: true,
      message: 'Quiz updated successfully',
      quiz
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Delete quiz
router.delete('/:id', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);

    if (!quiz) {
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    // Teachers can only delete their own quizzes
    if (req.user.role === 'teacher' && quiz.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Delete related quiz attempts
    await QuizAttempt.deleteMany({ quiz: quiz._id });
    await Quiz.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Quiz deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Submit quiz attempt
router.post('/:id/submit', auth, authorize('student'), async (req, res) => {
  try {
    const { answers, timeSpent } = req.body;
    const quizId = req.params.id;

    const quiz = await Quiz.findById(quizId).populate('questions');

    if (!quiz || !quiz.isPublished) {
      return res.status(404).json({
        success: false,
        message: 'Quiz not found or not published'
      });
    }

    // Check if student has exceeded max attempts
    const previousAttempts = await QuizAttempt.countDocuments({
      quiz: quizId,
      student: req.user._id
    });

    if (previousAttempts >= quiz.maxAttempts) {
      return res.status(400).json({
        success: false,
        message: 'Maximum attempts exceeded'
      });
    }

    // Calculate score
    let correctAnswers = 0;
    const processedAnswers = answers.map(answer => {
      const question = quiz.questions.find(q => q._id.toString() === answer.questionId);
      let isCorrect = false;

      if (question.questionType === 'multiple-choice') {
        const correctOption = question.options.find(opt => opt.isCorrect);
        isCorrect = correctOption && correctOption._id.toString() === answer.selectedAnswer;
      } else if (question.questionType === 'true-false') {
        const correctOption = question.options.find(opt => opt.isCorrect);
        isCorrect = correctOption && correctOption.text.toLowerCase() === answer.selectedAnswer.toLowerCase();
      } else if (question.questionType === 'short-answer') {
        isCorrect = question.correctAnswer.toLowerCase().trim() === answer.selectedAnswer.toLowerCase().trim();
      }

      if (isCorrect) correctAnswers++;

      return {
        question: question._id,
        selectedAnswer: answer.selectedAnswer,
        isCorrect,
        timeSpent: answer.timeSpent || 0
      };
    });

    const score = correctAnswers;
    const percentage = Math.round((correctAnswers / quiz.questions.length) * 100);
    const passed = percentage >= quiz.passingScore;

    // Create quiz attempt
    const attempt = new QuizAttempt({
      quiz: quizId,
      student: req.user._id,
      answers: processedAnswers,
      score,
      percentage,
      timeSpent,
      startedAt: new Date(Date.now() - timeSpent * 1000),
      submittedAt: new Date(),
      attemptNumber: previousAttempts + 1,
      passed
    });

    await attempt.save();

    // Update quiz statistics
    quiz.totalAttempts += 1;
    const allAttempts = await QuizAttempt.find({ quiz: quizId });
    const avgScore = allAttempts.reduce((sum, att) => sum + att.percentage, 0) / allAttempts.length;
    quiz.averageScore = Math.round(avgScore);
    await quiz.save();

    // Update user statistics
    const user = await User.findById(req.user._id);
    user.totalQuizzesTaken += 1;
    const userAttempts = await QuizAttempt.find({ student: req.user._id });
    const userAvgScore = userAttempts.reduce((sum, att) => sum + att.percentage, 0) / userAttempts.length;
    user.averageScore = Math.round(userAvgScore);
    await user.save();

    res.json({
      success: true,
      message: 'Quiz submitted successfully',
      attempt: {
        score,
        percentage,
        passed,
        timeSpent,
        attemptNumber: attempt.attemptNumber
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Get quiz attempts (for teachers to see student attempts)
router.get('/:id/attempts', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const quiz = await Quiz.findById(req.params.id);

    if (!quiz) {
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    // Teachers can only see attempts for their own quizzes
    if (req.user.role === 'teacher' && quiz.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const attempts = await QuizAttempt.find({ quiz: req.params.id })
      .populate('student', 'name email')
      .sort({ submittedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await QuizAttempt.countDocuments({ quiz: req.params.id });

    res.json({
      success: true,
      attempts,
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

module.exports = router;
