import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true, sparse: true },
    username: String,
    lastClaimed: Number,
    balance: { type: Number, default: 0 },
    exp: { type: Number, default: 0 },
    lastExpTime: Number,
});

const User = mongoose.model("User", userSchema);

async function initializeUserData(userId, username = null) {
    let user = await User.findOne({ userId });

    if (!user && username) {
        user = await User.findOne({ username, userId: { $exists: false } });
        if (user) {
            user.userId = userId;
            await user.save();
        }
    }

    if (!user) {
        user = new User({ userId, username });
        await user.save();
    }

    return user;
}

export async function getUserData(userId, username = null) {
    return await initializeUserData(userId, username);
}

export async function saveUserData(user) {
    await user.save();
}

export async function getLastClaimed(userId, username = null) {
    const user = await getUserData(userId, username);
    return user.lastClaimed;
}

export async function giveDailyReward(userId, username = null) {
    const now = Date.now();
    const user = await getUserData(userId, username);

    user.lastClaimed = now;
    user.balance += 1000;
    user.exp += 500;

    await saveUserData(user);
    return { balance: user.balance, exp: user.exp };
}

export async function getUserBalance(userId, username = null) {
    const user = await getUserData(userId, username);
    return user.balance;
}

export async function getUserExp(userId, username = null) {
    const user = await getUserData(userId, username);
    return user.exp;
}

export async function addExpOnMessage(
    userId,
    username,
    expToAdd = 10,
    cooldownTime = 30000
) {
    const user = await getUserData(userId, username);

    if (!user.username || user.username !== username) {
        user.username = username;
    }

    const now = Date.now();
    const lastExpTime = user.lastExpTime || 0;
    const timeSinceLastExp = now - lastExpTime;

    if (timeSinceLastExp < cooldownTime) {
        return {
            success: false,
            remainingTime: cooldownTime - timeSinceLastExp,
        };
    }

    const previousLevel = calculateLevel(user.exp);
    user.exp += expToAdd;
    user.lastExpTime = now;
    const currentLevel = calculateLevel(user.exp);

    await saveUserData(user);

    const leveledUp = currentLevel > previousLevel;

    return {
        success: true,
        expAdded: expToAdd,
        totalExp: user.exp,
        currentLevel,
        previousLevel,
        leveledUp,
    };
}

export async function handleUserMessage(
    userId,
    username,
    expPerMessage = 10,
    cooldownTime = 30000,
    assignRoleFunction = null,
    roleMap = {}
) {
    const result = await addExpOnMessage(
        userId,
        username,
        expPerMessage,
        cooldownTime
    );

    if (result.success && result.leveledUp && assignRoleFunction) {
        const roleId = roleMap[result.currentLevel];
        if (roleId) {
            await assignRoleFunction(userId, roleId);
        }
    }

    return result;
}

export function calculateLevel(exp) {
    return Math.floor(0.1 * Math.sqrt(exp));
}

export async function getUserLevel(userId, username = null) {
    const user = await getUserData(userId, username);
    return calculateLevel(user.exp);
}
