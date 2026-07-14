const db = require("../config/sqlite.config");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

async function generateToken(storeId, phoneNumber) {
    return jwt.sign(
        { storeId, phoneNumber },
        (process.env.JWT_SECRET || "").trim(),
        { expiresIn: process.env.JWT_EXPIRES_IN || "5h" }
    );
}

function signupService(name, phonenumber, password, email, district, state, address, cache_folder) {
    return new Promise(async (resolve, reject) => {
        try {
            const hash = await bcrypt.hash(password, 10);

            db.run(
                `INSERT INTO stores (store_name, phone_number, password, email, district, state, address, cache_folder)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [name, phonenumber, hash, email || null, district, state, address, cache_folder],
                async function (err) {
                    if (err) {
                        // UNIQUE constraint on phone_number or email
                        if (err.code === "SQLITE_CONSTRAINT") {
                            return resolve({
                                status: 409,
                                message: "Phone number or email already registered"
                            });
                        }
                        return reject(err);
                    }

                    const token = await generateToken(this.lastID, phonenumber);
                    resolve({ status: 201, token });
                }
            );
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = signupService;
