const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE SETUP ---
const db = new sqlite3.Database('./library.db', (err) => {
    if (err) console.error(err.message);
    else {
        console.log("Connected to Final Master SQLite database.");
        
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE, password TEXT, role TEXT,
            name TEXT, section TEXT, semester TEXT, year TEXT, roll_no TEXT UNIQUE,
            status TEXT DEFAULT 'Approved'
        )`, () => {
            db.get("SELECT count(*) as count FROM users", (err, row) => {
                if (row && row.count === 0) {
                    db.run("INSERT INTO users (username, password, role, name, status) VALUES ('admin', 'admin123', 'Management', 'System Admin', 'Approved'), ('teacher', 'teacher123', 'Teacher', 'Head Teacher', 'Approved')");
                }
            });
        });

        db.run(`CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT, category TEXT, author TEXT,
            isbn TEXT UNIQUE, price REAL, quantity INTEGER, available INTEGER
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS borrow_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER, student_username TEXT,
            start_date DATE, end_date DATE, status TEXT DEFAULT 'Pending'
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS issued_books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER, student_username TEXT,
            issue_date DATE, due_date DATE, return_date DATE, status TEXT DEFAULT 'Issued'
        )`);
    }
});

// --- API ROUTES ---

// 1. User Authentication & Signup
app.post('/api/login', (req, res) => {
    db.get("SELECT id, username, role, status FROM users WHERE username = ? AND password = ?", [req.body.username, req.body.password], (err, user) => {
        if (user) {
            if (user.status === 'Pending') res.status(401).json({ success: false, message: "Account pending Admin approval." });
            else res.json({ success: true, user });
        } else {
            res.status(401).json({ success: false, message: "Invalid credentials." });
        }
    });
});

app.post('/api/signup', (req, res) => {
    const { name, section, semester, year, roll_no, password } = req.body;
    const username = `stu_${roll_no}`.toLowerCase(); 

    db.run("INSERT INTO users (username, password, role, name, section, semester, year, roll_no, status) VALUES (?, ?, 'Student', ?, ?, ?, ?, ?, 'Pending')",
    [username, password, name, section, semester, year, roll_no], function(err) {
        if (err) return res.status(400).json({ error: "Roll number already registered!" });
        res.json({ success: true, username: username });
    });
});

// 2. Admin: Student Management
app.get('/api/students/pending', (req, res) => { db.all("SELECT * FROM users WHERE role = 'Student' AND status = 'Pending'", [], (err, rows) => res.json(rows)); });
app.get('/api/students/approved', (req, res) => { db.all("SELECT * FROM users WHERE role = 'Student' AND status = 'Approved'", [], (err, rows) => res.json(rows)); });
app.post('/api/students/:id/approve', (req, res) => { db.run("UPDATE users SET status = 'Approved' WHERE id = ?", [req.params.id], () => res.json({ success: true })); });
app.post('/api/students/:id/reject', (req, res) => { db.run("DELETE FROM users WHERE id = ?", [req.params.id], () => res.json({ success: true })); });

// Dashboard Statistics
app.get('/api/stats', (req, res) => {
    db.get("SELECT sum(quantity) as totalBooks FROM books", [], (err, row1) => {
        db.get("SELECT count(*) as totalIssued FROM issued_books WHERE status = 'Issued'", [], (err, row2) => {
            db.get("SELECT count(*) as pendingReqs FROM borrow_requests WHERE status = 'Pending'", [], (err, row3) => {
                res.json({ books: row1 && row1.totalBooks ? row1.totalBooks : 0, issued: row2 && row2.totalIssued ? row2.totalIssued : 0, pending: row3 && row3.pendingReqs ? row3.pendingReqs : 0 });
            });
        });
    });
});

// --- BOOK & ISSUE MANAGEMENT ---
app.get('/api/books', (req, res) => { db.all("SELECT * FROM books", [], (err, rows) => res.json(rows)); });
app.post('/api/books', (req, res) => {
    const { title, category, author, isbn, price, quantity } = req.body;
    db.run("INSERT INTO books (title, category, author, isbn, price, quantity, available) VALUES (?, ?, ?, ?, ?, ?, ?)", 
    [title, category, author, isbn, price, quantity, quantity], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});
app.delete('/api/books/:id', (req, res) => { db.run("DELETE FROM books WHERE id = ?", req.params.id, () => res.json({ success: true })); });

// --- SECURITY FIX: Only allow registered students to borrow ---
app.post('/api/request', (req, res) => {
    const { book_id, student_username, start_date, end_date } = req.body;
    
    // Verify the student exists and is approved in the database before issuing
    db.get("SELECT username FROM users WHERE username = ? AND role = 'Student' AND status = 'Approved'", [student_username], (err, student) => {
        if (!student) {
            return res.status(400).json({ error: "Invalid User: Books can only be issued to registered and approved students." });
        }

        db.run("INSERT INTO borrow_requests (book_id, student_username, start_date, end_date) VALUES (?, ?, ?, ?)", 
            [book_id, student_username, start_date, end_date], () => res.json({ success: true }));
    });
});

app.get('/api/requests', (req, res) => {
    const query = `SELECT borrow_requests.*, books.title, books.isbn FROM borrow_requests 
                   JOIN books ON borrow_requests.book_id = books.id WHERE borrow_requests.status = 'Pending'`;
    db.all(query, [], (err, rows) => res.json(rows));
});
app.post('/api/request/:id/approve', (req, res) => {
    const reqId = req.params.id;
    db.get("SELECT * FROM borrow_requests WHERE id = ?", [reqId], (err, request) => {
        if (request && request.status === 'Pending') {
            db.get("SELECT available FROM books WHERE id = ?", [request.book_id], (err, book) => {
                if (book && book.available > 0) {
                    db.run("UPDATE borrow_requests SET status = 'Approved' WHERE id = ?", [reqId]);
                    db.run("INSERT INTO issued_books (book_id, student_username, issue_date, due_date, status) VALUES (?, ?, ?, ?, 'Issued')",
                        [request.book_id, request.student_username, request.start_date, request.end_date]);
                    db.run("UPDATE books SET available = available - 1 WHERE id = ?", [request.book_id], () => res.json({ success: true }));
                } else { res.status(400).json({ error: "Book out of stock" }); }
            });
        }
    });
});
app.post('/api/request/:id/reject', (req, res) => { db.run("UPDATE borrow_requests SET status = 'Rejected' WHERE id = ?", [req.params.id], () => res.json({ success: true })); });

app.get('/api/issued', (req, res) => {
    const query = `SELECT issued_books.id as issue_id, issued_books.student_username, issued_books.issue_date, issued_books.due_date, issued_books.status, books.title 
                   FROM issued_books JOIN books ON issued_books.book_id = books.id`;
    db.all(query, [], (err, rows) => res.json(rows));
});
app.post('/api/return/:issue_id', (req, res) => {
    const issue_id = req.params.issue_id;
    const now = new Date().toISOString().split('T')[0];
    db.get("SELECT book_id FROM issued_books WHERE id = ?", [issue_id], (err, row) => {
        if (row) {
            db.run("UPDATE issued_books SET status = 'Returned', return_date = ? WHERE id = ?", [now, issue_id], () => {
                db.run("UPDATE books SET available = available + 1 WHERE id = ?", [row.book_id], () => res.json({ success: true }));
            });
        }
    });
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));