import { runTests } from './runner';
import path from 'path';

const testFile = path.resolve(__dirname, '../.zero_magic/tests/test_sample.py');

(async () => {
  console.log(`Running pytest on: ${testFile}`);
  const result = await runTests(testFile, 'python');
  console.log('Result:', result);
})();
