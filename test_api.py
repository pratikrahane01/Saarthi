import requests
import json

url = "http://127.0.0.1:8000/v1/missions/analyze-all"

payload = {
    "language": "python",
    "fullCode": "def process_data(data, multiplier=2):\n    result = dat * multiplier\n    return result\n\ndef calculate_stats(numbers)\n    average = sum(numbers) / len(numbers) if numbers else 0\n    return average\n\ndef main():\n    val = process_data([1, 2, 3])\n    stats = calculate_stats([4, 5 6])\n    print(f\"Val: {val}, Stats: {stats}\")\n\nif __name__ == \"__main__\":\n    main(",
    "diagnostics": [
        {
            "lineNumber": 3,
            "message": "\"dat\" is not defined",
            "errorCode": "reportUndefinedVariable",
            "severity": "Error"
        },
        {
            "lineNumber": 6,
            "message": "Expected ':'",
            "errorCode": "Unknown",
            "severity": "Error"
        }
    ]
}

response = requests.post(url, json=payload)
print(response.status_code)
print(json.dumps(response.json(), indent=2))
