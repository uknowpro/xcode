# Run xcode in CI

Install the release package in the job and set the API token with the runner's secret mechanism. Use a dedicated xcode data directory for the job.

```sh
export XCODE_HOME="$RUNNER_TEMP/xcode"
xcode profile set ci --endpoint "$MODEL_ENDPOINT" --model "$MODEL_ID"
xcode check add unit -- npm test
xcode harness checks implement unit
status=0
printf '%s\n' 'Propose a focused fix and run the configured verification when applicable.' |
  xcode ask --profile ci --harness implement --checks --write --json > xcode-result.json || status=$?
case "$status" in
  0) printf '%s\n' 'Request finished. Inspect the verification field in the report.' ;;
  3) printf '%s\n' 'Review the requested changes before applying.' ;;
  4) printf '%s\n' 'One or more registered checks failed.' ;;
  *) printf '%s\n' 'Execution failed.' ;;
esac
exit "$status"
```

Set `XCODE_API_TOKEN` as a secret job environment variable. The JSON result includes the answer and relative changed paths. Publish it as a job artifact only if the audience can access the source material.
