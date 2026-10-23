#!/usr/bin/env python3
"""Publish the collectible-card preview using the existing bounded installer."""
import argparse
from pathlib import Path
import deploy_online_preview as deploy

deploy.PREFIX = '/joey/custom-preview/'
deploy.UNIT = 'joey-custom-preview.service'
deploy.PORT = 18893
deploy.CONFIG_NAME = 'custom-preview-config.json'
deploy.RELEASE_NAME = 'custom-preview-releases'
deploy.REPORT_NAME = 'custom-preview-deployment.json'
deploy.PREVIEW_FLAG = 'customPreview'

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('sha256')
    args = parser.parse_args()
    deploy.main(args.archive, args.sha256)
