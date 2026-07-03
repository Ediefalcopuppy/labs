console.log("Welcome to the Bun TypeScript hello world program!");

const username = prompt("What is your name? ") ?? "friend";

console.log(`Hello, ${username}! Nice to meet you.`);

const firstNumber = Math.floor(Math.random() * 10) + 1;
const secondNumber = Math.floor(Math.random() * 10) + 1;
const operators = ["+", "-", "*"];
const operator = operators[Math.floor(Math.random() * operators.length)];

let correctAnswer: number;

if (operator === "+") {
  correctAnswer = firstNumber + secondNumber;
} else if (operator === "-") {
  correctAnswer = firstNumber - secondNumber;
} else {
  correctAnswer = firstNumber * secondNumber;
}

const userAnswer = prompt(`Quick math question: What is ${firstNumber} ${operator} ${secondNumber}? `);
const numericAnswer = Number(userAnswer);

if (numericAnswer === correctAnswer) {
  console.log(`Great job, ${username}! You got it right.`);
} else {
  console.log(`Nice try, ${username}. The correct answer was ${correctAnswer}.`);
}
