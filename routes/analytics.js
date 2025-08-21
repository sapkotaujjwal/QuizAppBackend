const express = require('express');
const Quiz = require('../models/Quiz');
const Question = require('../models/Question');
const QuizAttempt = require('../models/QuizAttempt');
const User = require('../models/User');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// Get dashboard statistics
router.get('/dashboard', auth, async (req, res) => {
  try {
    let stats = {};

    if (req.user.role === 'admin') {
      // Admin sees everything
      stats = {
        totalUsers: await User.countDocuments(),
        totalTeachers: await User.countDocuments({ role: 'teacher' }),
        totalStudents: await User.countDocuments({ role: 'student' }),
        totalQuizzes: await Quiz.countDocuments(),
        totalQuestions: await Question.countDocuments(),
        totalAttempts: await QuizAttempt.countDocuments(),
        recentUsers: await User.find().sort({ createdAt: -1 }).limit(5).select('name email role createdAt'),
        recentQuizzes: await Quiz.find().populate('createdBy', 'name').sort({ createdAt: -1 }).limit(5),
        recentQuestions: await Question.find().populate('createdBy', 'name').sort({ createdAt: -1 }).limit(5),
      };
    } else if (req.user.role === 'teacher') {
      // Teacher sees their own content and students
      const teacherQuizzes = await Quiz.find({ createdBy: req.user._id });
      const quizIds = teacherQuizzes.map(q => q._id);
      
      stats = {
        totalQuizzes: teacherQuizzes.length,
        totalQuestions: await Question.countDocuments({ createdBy: req.user._id }),
        totalAttempts: await QuizAttempt.countDocuments({ quiz: { $in: quizIds } }),
        publishedQuizzes: await Quiz.countDocuments({ createdBy: req.user._id, isPublished: true }),
        recentAttempts: await QuizAttempt.find({ quiz: { $in: quizIds } })
          .populate('student', 'name')
          .populate('quiz', 'title')
          .sort({ submittedAt: -1 })
          .limit(10),
        topPerformingQuizzes: await Quiz.find({ createdBy: req.user._id })
          .sort({ averageScore: -1 })
          .limit(5)
          .select('title averageScore totalAttempts')
      };
    } else if (req.user.role === 'student') {
      // Student sees their own progress
      const userAttempts = await QuizAttempt.find({ student: req.user._id });
      
      stats = {
        totalAttempts: userAttempts.length,
        averageScore: req.user.averageScore || 0,
        passedQuizzes: userAttempts.filter(a => a.passed).length,
        recentAttempts: await QuizAttempt.find({ student: req.user._id })
          .populate('quiz', 'title subject')
          .sort({ submittedAt: -1 })
          .limit(10),
        availableQuizzes: await Quiz.countDocuments({ 
          isPublished: true,
          $or: [
            { allowedStudents: { $in: [req.user._id] } },
            { allowedStudents: { $size: 0 } }
          ]
        })
      };
    }

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Get detailed student performance (for teachers)
router.get('/student-performance', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const { studentId, quizId } = req.query;
    
    let query = {};
    if (studentId) query.student = studentId;
    if (quizId) query.quiz = quizId;
    
    // If teacher, only show attempts for their quizzes
    if (req.user.role === 'teacher') {
      const teacherQuizzes = await Quiz.find({ createdBy: req.user._id }).select('_id');
      const quizIds = teacherQuizzes.map(q => q._id);
      query.quiz = query.quiz ? query.quiz : { $in: quizIds };
    }

    const attempts = await QuizAttempt.find(query)
      .populate('student', 'name email')
      .populate('quiz', 'title subject passingScore')
      .sort({ submittedAt: -1 })
      .limit(50);

    // Calculate performance metrics
    const performanceData = attempts.reduce((acc, attempt) => {
      const studentId = attempt.student._id.toString();
      if (!acc[studentId]) {
        acc[studentId] = {
          student: attempt.student,
          attempts: [],
          totalAttempts: 0,
          averageScore: 0,
          passRate: 0
        };
      }
      
      acc[studentId].attempts.push({
        quiz: attempt.quiz,
        score: attempt.percentage,
        passed: attempt.passed,
        submittedAt: attempt.submittedAt
      });
      
      return acc;
    }, {});

    // Calculate final metrics
    Object.values(performanceData).forEach(data => {
      data.totalAttempts = data.attempts.length;
      data.averageScore = data.attempts.reduce((sum, att) => sum + att.score, 0) / data.attempts.length;
      data.passRate = (data.attempts.filter(att => att.passed).length / data.attempts.length) * 100;
    });

    res.json({
      success: true,
      performanceData: Object.values(performanceData)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Get quiz analytics (for teachers)
router.get('/quiz-analytics/:id', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id).populate('questions');

    if (!quiz) {
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    // Teachers can only see analytics for their own quizzes
    if (req.user.role === 'teacher' && quiz.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const attempts = await QuizAttempt.find({ quiz: req.params.id })
      .populate('student', 'name');

    // Question-wise analytics
    const questionAnalytics = quiz.questions.map(question => {
      const questionAttempts = attempts.map(attempt => 
        attempt.answers.find(ans => ans.question.toString() === question._id.toString())
      ).filter(Boolean);

      const correctCount = questionAttempts.filter(ans => ans.isCorrect).length;
      const totalCount = questionAttempts.length;

      return {
        question: {
          _id: question._id,
          title: question.title,
          difficulty: question.difficulty
        },
        totalAttempts: totalCount,
        correctAnswers: correctCount,
        correctPercentage: totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0,
        averageTimeSpent: totalCount > 0 
          ? Math.round(questionAttempts.reduce((sum, ans) => sum + (ans.timeSpent || 0), 0) / totalCount)
          : 0
      };
    });

    // Overall analytics
    const analytics = {
      quiz: {
        title: quiz.title,
        totalAttempts: attempts.length,
        averageScore: quiz.averageScore,
        passRate: attempts.length > 0 
          ? Math.round((attempts.filter(att => att.passed).length / attempts.length) * 100)
          : 0
      },
      questionAnalytics,
      scoreDistribution: {
        '0-20': attempts.filter(att => att.percentage >= 0 && att.percentage < 21).length,
        '21-40': attempts.filter(att => att.percentage >= 21 && att.percentage < 41).length,
        '41-60': attempts.filter(att => att.percentage >= 41 && att.percentage < 61).length,
        '61-80': attempts.filter(att => att.percentage >= 61 && att.percentage < 81).length,
        '81-100': attempts.filter(att => att.percentage >= 81).length
      },
      recentAttempts: attempts.slice(-10).map(att => ({
        student: att.student.name,
        score: att.percentage,
        passed: att.passed,
        submittedAt: att.submittedAt
      }))
    };

    res.json({
      success: true,
      analytics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Get question analytics
router.get('/question-analytics/:id', auth, authorize('admin', 'teacher'), async (req, res) => {
  try {
    const question = await Question.findById(req.params.id).populate('createdBy', 'name');

    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    // Teachers can only see analytics for their own questions
    if (req.user.role === 'teacher' && question.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const attempts = await QuizAttempt.find({ 'answers.question': req.params.id })
      .populate('student', 'name');

    // Overall analytics
    const analytics = {
      question: {
        title: question.title,
        totalAttempts: attempts.length,
        correctAnswers: attempts.filter(att => att.answers.find(ans => ans.question.toString() === req.params.id && ans.isCorrect)).length,
        incorrectAnswers: attempts.filter(att => att.answers.find(ans => ans.question.toString() === req.params.id && !ans.isCorrect)).length
      },
      recentAttempts: attempts.slice(-10).map(att => ({
        student: att.student.name,
        submittedAt: att.submittedAt,
        score: att.percentage,
        passed: att.passed
      }))
    };

    res.json({
      success: true,
      analytics
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