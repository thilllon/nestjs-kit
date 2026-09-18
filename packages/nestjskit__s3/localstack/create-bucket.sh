#!/bin/bash

echo "Creating S3 bucket"

aws --endpoint-url=http://localhost:4566 s3api create-bucket --bucket my-bucket --region us-east-1

echo "Bucket created"
